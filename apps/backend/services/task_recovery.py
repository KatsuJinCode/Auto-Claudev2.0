#!/usr/bin/env python3
"""
Task Recovery System
====================

Provides file locking, zombie detection, and recovery orchestration
for tasks that become stuck in inconsistent states.

Key components:
- task_lock: Cross-platform file locking context manager
- worktree_exists: Check if a worktree exists for a task
- is_zombie: Detect tasks stuck with no progress for 2+ hours
- recover_if_stuck: Detect and fix state/filesystem mismatches
- touch_activity: Update activity marker to prevent zombie detection
- start_coding: Atomic transition from ready to coding state
"""

import logging
from collections.abc import Generator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import portalocker

from services.task_state import TaskState

logger = logging.getLogger(__name__)

# Lock timeout in seconds
LOCK_TIMEOUT_SECONDS = 30


@contextmanager
def task_lock(task_id: str, base_dir: Path) -> Generator[bool, None, None]:
    """
    Lock task state file during access.

    Uses exclusive file locking to prevent race conditions when multiple
    processes access task state. Yields False on lock failure (timeout).

    Args:
        task_id: Unique identifier for the task.
        base_dir: Base directory where task files are stored.

    Yields:
        True if lock was acquired successfully, False on timeout.

    Example:
        with task_lock("my-task", Path("/tasks")) as acquired:
            if acquired:
                # Safe to modify task state
                ...
            else:
                # Could not acquire lock, try again later
                ...
    """
    task_dir = base_dir / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    lock_path = task_dir / ".lock"

    lock = portalocker.Lock(
        str(lock_path),
        flags=portalocker.LOCK_EX | portalocker.LOCK_NB,
        timeout=LOCK_TIMEOUT_SECONDS,
    )

    try:
        lock.acquire()
        yield True
    except portalocker.LockException:
        logger.warning(
            f"LOCK_TIMEOUT {task_id}: could not acquire lock in {LOCK_TIMEOUT_SECONDS}s"
        )
        yield False
    finally:
        try:
            lock.release()
        except Exception:
            pass


def worktree_exists(base_dir: Path, task_id: str) -> bool:
    """
    Check if a worktree exists for a task.

    Worktrees are stored in .worktrees/{task_id}/ relative to the base directory.
    This follows the per-spec worktree architecture where each task gets its own
    isolated worktree.

    Args:
        base_dir: Project root directory containing the .worktrees folder.
        task_id: Unique identifier for the task (spec name).

    Returns:
        True if the worktree directory exists, False otherwise.

    Example:
        if worktree_exists(Path("/project"), "my-task"):
            # Worktree exists at /project/.worktrees/my-task/
            ...
    """
    worktree_path = base_dir / ".worktrees" / task_id
    return worktree_path.exists()


# Zombie detection threshold in hours
ZOMBIE_THRESHOLD_HOURS = 2

# Activity marker file name
ACTIVITY_MARKER_FILE = ".task_activity"


def is_zombie(state: TaskState, base_dir: Path) -> bool:
    """
    Detect if a task is a zombie (stuck with no progress for 2+ hours).

    A task is considered a zombie if:
    1. The last_activity timestamp is older than ZOMBIE_THRESHOLD_HOURS, AND
    2. The .task_activity marker file is missing OR is also older than the threshold

    The activity marker file provides a secondary signal that a worker is still
    actively processing the task, even if the state file hasn't been updated.

    Args:
        state: The TaskState to check for zombie status.
        base_dir: Project root directory containing the .worktrees folder.

    Returns:
        True if the task appears to be stuck (zombie), False otherwise.

    Example:
        if is_zombie(state, Path("/project")):
            # Task has been idle for 2+ hours, consider recovery
            ...
    """
    # Parse last_activity timestamp, handling both naive and aware datetimes
    try:
        last_activity = datetime.fromisoformat(state.last_activity)
        # Convert naive timestamps to UTC explicitly
        if last_activity.tzinfo is None:
            last_activity = last_activity.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError) as e:
        # If timestamp is invalid/missing, treat as zombie
        logger.warning(
            f"Invalid last_activity timestamp for task {state.task_id}: {e}"
        )
        return True

    now = datetime.now(timezone.utc)
    threshold = timedelta(hours=ZOMBIE_THRESHOLD_HOURS)
    time_since_activity = now - last_activity

    # If last_activity is recent, not a zombie
    if time_since_activity < threshold:
        return False

    # Last activity is old, check the activity marker file
    activity_marker = base_dir / ".worktrees" / state.task_id / ACTIVITY_MARKER_FILE

    if not activity_marker.exists():
        # No activity marker and last_activity is old => zombie
        logger.info(
            f"ZOMBIE_DETECTED {state.task_id}: no activity marker, "
            f"last_activity was {time_since_activity.total_seconds() / 3600:.1f} hours ago"
        )
        return True

    # Check activity marker file modification time
    try:
        marker_mtime = datetime.fromtimestamp(
            activity_marker.stat().st_mtime, tz=timezone.utc
        )
        time_since_marker = now - marker_mtime

        if time_since_marker >= threshold:
            # Activity marker is also old => zombie
            logger.info(
                f"ZOMBIE_DETECTED {state.task_id}: activity marker is "
                f"{time_since_marker.total_seconds() / 3600:.1f} hours old"
            )
            return True

        # Activity marker is recent, worker is still alive
        return False

    except OSError as e:
        # Can't read marker file, treat as zombie to be safe
        logger.warning(
            f"Could not read activity marker for task {state.task_id}: {e}"
        )
        return True


# Maximum recovery attempts before marking task as permanently failed
MAX_RECOVERY_ATTEMPTS = 5

# Recovery action return values
RECOVERY_ACTION_NONE = "no_action"
RECOVERY_ACTION_RESET_TO_READY = "reset_to_ready"
RECOVERY_ACTION_RESET_TO_BACKLOG = "reset_to_backlog"
RECOVERY_ACTION_UPDATE_TO_CODING = "update_to_coding"
RECOVERY_ACTION_MARK_FAILED = "mark_failed"
RECOVERY_ACTION_ZOMBIE_CLEANUP = "zombie_cleanup"
RECOVERY_ACTION_LOCK_FAILED = "lock_failed"
RECOVERY_ACTION_NO_STATE = "no_state"


def _remove_worktree(base_dir: Path, task_id: str) -> bool:
    """
    Remove a worktree for a task using git worktree remove.

    This is a best-effort cleanup operation. Failures are logged but don't
    block the recovery process.

    Args:
        base_dir: Project root directory containing the .worktrees folder.
        task_id: Unique identifier for the task.

    Returns:
        True if removal succeeded or worktree didn't exist, False on error.
    """
    import subprocess

    worktree_path = base_dir / ".worktrees" / task_id

    if not worktree_path.exists():
        return True

    try:
        # Use --force to remove even if there are uncommitted changes
        result = subprocess.run(
            ["git", "worktree", "remove", "--force", str(worktree_path)],
            cwd=str(base_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode == 0:
            logger.info(f"WORKTREE_REMOVED {task_id}: cleaned up stale worktree")
            return True
        else:
            logger.warning(
                f"WORKTREE_REMOVE_FAILED {task_id}: git worktree remove failed: "
                f"{result.stderr.strip()}"
            )
            return False

    except subprocess.TimeoutExpired:
        logger.warning(f"WORKTREE_REMOVE_TIMEOUT {task_id}: removal timed out")
        return False
    except Exception as e:
        logger.warning(f"WORKTREE_REMOVE_ERROR {task_id}: {e}")
        return False


def recover_if_stuck(
    task_id: str,
    base_dir: Path,
    state_dir: Path | None = None,
) -> str:
    """
    Detect and fix state/filesystem mismatches for a task.

    This function handles 4 recovery cases:
    1. coding without worktree: status="coding" but no worktree → reset to "ready"
    2. zombie task: task stuck 2+ hours with no activity → reset to "ready", cleanup worktree
    3. worktree without coding status: worktree exists but status="ready" → update to "coding"
    4. planning stalled: planning status >2 hours idle → reset to "backlog"

    Recovery is bounded by MAX_RECOVERY_ATTEMPTS (5). Tasks exceeding this limit
    are marked as permanently "failed".

    Args:
        task_id: Unique identifier for the task.
        base_dir: Project root directory containing the .worktrees folder.
        state_dir: Directory where task state files are stored. If None, uses
            base_dir / ".auto-claude" / "specs".

    Returns:
        Action string indicating what was done:
        - "no_action": Task state is consistent, no recovery needed
        - "reset_to_ready": Task was reset to ready state
        - "reset_to_backlog": Planning task was reset to backlog
        - "update_to_coding": Task status updated to match existing worktree
        - "mark_failed": Task marked as permanently failed (max retries exceeded)
        - "zombie_cleanup": Zombie task cleaned up and reset
        - "lock_failed": Could not acquire lock, retry next cycle
        - "no_state": No state file found for task

    Example:
        action = recover_if_stuck("my-task", Path("/project"))
        if action == "lock_failed":
            # Retry next polling cycle
            ...
        elif action == "mark_failed":
            # Task permanently failed, notify user
            ...
    """
    # Import here to avoid circular dependency
    from services.task_state import load_state, save_state, utc_now

    # Default state directory follows Auto-Claude convention
    if state_dir is None:
        state_dir = base_dir / ".auto-claude" / "specs"

    # Acquire lock before modifying state
    with task_lock(task_id, state_dir) as acquired:
        if not acquired:
            return RECOVERY_ACTION_LOCK_FAILED

        # Load current state
        state = load_state(task_id, state_dir)
        if state is None:
            logger.warning(f"NO_STATE {task_id}: no state file found, cannot recover")
            return RECOVERY_ACTION_NO_STATE

        old_status = state.status

        # Check if max recovery attempts exceeded
        if state.recovery_attempts >= MAX_RECOVERY_ATTEMPTS:
            if state.status != "failed":
                state.status = "failed"
                state.failure_reason = (
                    f"Maximum recovery attempts ({MAX_RECOVERY_ATTEMPTS}) exceeded"
                )
                state.last_activity = utc_now()
                save_state(state, state_dir)
                logger.error(
                    f"RECOVERY_MAX_RETRIES {task_id}: marking as failed after "
                    f"{MAX_RECOVERY_ATTEMPTS} recovery attempts"
                )
                return RECOVERY_ACTION_MARK_FAILED
            # Already failed, no action needed
            return RECOVERY_ACTION_NONE

        # Don't recover tasks that are already done or failed
        if state.status in ("done", "failed"):
            return RECOVERY_ACTION_NONE

        # Check for worktree existence
        has_worktree = worktree_exists(base_dir, task_id)

        # Case 1: coding without worktree
        if state.status == "coding" and not has_worktree:
            state.status = "ready"
            state.recovery_attempts += 1
            state.last_activity = utc_now()
            save_state(state, state_dir)
            logger.warning(
                f"RECOVERY {task_id}: status was 'coding' but no worktree exists. "
                f"Reset to 'ready' (attempt {state.recovery_attempts}/{MAX_RECOVERY_ATTEMPTS})"
            )
            return RECOVERY_ACTION_RESET_TO_READY

        # Case 2: zombie task (coding with worktree but no activity)
        if state.status == "coding" and has_worktree:
            if is_zombie(state, base_dir):
                # Clean up the stale worktree
                _remove_worktree(base_dir, task_id)

                state.status = "ready"
                state.recovery_attempts += 1
                state.last_activity = utc_now()
                save_state(state, state_dir)
                logger.warning(
                    f"RECOVERY_ZOMBIE {task_id}: zombie task detected (no activity for "
                    f"{ZOMBIE_THRESHOLD_HOURS}+ hours). Reset to 'ready', worktree removed "
                    f"(attempt {state.recovery_attempts}/{MAX_RECOVERY_ATTEMPTS})"
                )
                return RECOVERY_ACTION_ZOMBIE_CLEANUP

        # Case 3: worktree exists but status is ready (orphaned worktree)
        if state.status == "ready" and has_worktree:
            state.status = "coding"
            state.last_activity = utc_now()
            # Don't increment recovery_attempts for this case - it's a state sync, not a failure
            save_state(state, state_dir)
            logger.info(
                f"RECOVERY_SYNC {task_id}: worktree exists but status was 'ready'. "
                f"Updated to 'coding' to match filesystem state"
            )
            return RECOVERY_ACTION_UPDATE_TO_CODING

        # Case 4: planning stalled (planning status with no activity for 2+ hours)
        if state.status == "planning":
            # Reuse is_zombie logic to check for stalled planning
            # Create a temporary state object for zombie check
            if is_zombie(state, base_dir):
                state.status = "backlog"
                state.recovery_attempts += 1
                state.last_activity = utc_now()
                save_state(state, state_dir)
                logger.warning(
                    f"RECOVERY_PLANNING_STALLED {task_id}: planning phase stalled for "
                    f"{ZOMBIE_THRESHOLD_HOURS}+ hours. Reset to 'backlog' "
                    f"(attempt {state.recovery_attempts}/{MAX_RECOVERY_ATTEMPTS})"
                )
                return RECOVERY_ACTION_RESET_TO_BACKLOG

        # No recovery needed
        return RECOVERY_ACTION_NONE


# Start coding action return values
START_CODING_SUCCESS = "success"
START_CODING_LOCK_FAILED = "lock_failed"
START_CODING_NO_STATE = "no_state"
START_CODING_WRONG_STATUS = "wrong_status"
START_CODING_WORKTREE_FAILED = "worktree_failed"
START_CODING_MAX_RETRIES = "max_retries"


def _create_worktree(base_dir: Path, task_id: str, base_branch: str | None = None) -> bool:
    """
    Create a worktree for a task.

    Creates a git worktree at .worktrees/{task_id}/ with a new branch
    auto-claude/{task_id} based off the base branch.

    Args:
        base_dir: Project root directory.
        task_id: Unique identifier for the task (spec name).
        base_branch: Base branch to create worktree from. If None, auto-detects
            main/master or falls back to current branch.

    Returns:
        True if worktree created successfully, False on error.
    """
    import subprocess

    worktree_path = base_dir / ".worktrees" / task_id
    branch_name = f"auto-claude/{task_id}"

    # Auto-detect base branch if not provided
    if base_branch is None:
        # Try main, then master, then current branch
        for candidate in ["main", "master"]:
            result = subprocess.run(
                ["git", "rev-parse", "--verify", candidate],
                cwd=str(base_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                base_branch = candidate
                break

        if base_branch is None:
            # Fall back to current branch
            result = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=str(base_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                base_branch = result.stdout.strip()
            else:
                logger.error(
                    f"WORKTREE_CREATE_FAILED {task_id}: could not determine base branch"
                )
                return False

    try:
        # Remove existing worktree if present (from crashed previous run)
        if worktree_path.exists():
            result = subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree_path)],
                cwd=str(base_dir),
                capture_output=True,
                text=True,
                timeout=60,
            )
            # Don't fail if removal fails - just log and continue

        # Delete branch if it exists (from previous attempt)
        subprocess.run(
            ["git", "branch", "-D", branch_name],
            cwd=str(base_dir),
            capture_output=True,
            text=True,
            timeout=30,
        )

        # Create worktree with new branch from base
        result = subprocess.run(
            ["git", "worktree", "add", "-b", branch_name, str(worktree_path), base_branch],
            cwd=str(base_dir),
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            logger.error(
                f"WORKTREE_CREATE_FAILED {task_id}: git worktree add failed: "
                f"{result.stderr.strip()}"
            )
            return False

        logger.info(
            f"WORKTREE_CREATED {task_id}: created at {worktree_path} "
            f"on branch {branch_name} from {base_branch}"
        )
        return True

    except subprocess.TimeoutExpired:
        logger.error(f"WORKTREE_CREATE_TIMEOUT {task_id}: operation timed out")
        return False
    except Exception as e:
        logger.error(f"WORKTREE_CREATE_ERROR {task_id}: {e}")
        return False


def touch_activity(task_id: str, base_dir: Path) -> bool:
    """
    Update activity marker to prevent zombie detection.

    Creates or updates the modification time of the .task_activity marker file
    in the task's worktree directory. Workers should call this periodically
    (every 5-10 minutes) during coding to signal they are still alive.

    Args:
        task_id: Unique identifier for the task (spec name).
        base_dir: Project root directory containing the .worktrees folder.

    Returns:
        True if marker was touched successfully, False on error.

    Example:
        # Worker should call periodically during long operations
        touch_activity("my-task", Path("/project"))
    """
    activity_marker = base_dir / ".worktrees" / task_id / ACTIVITY_MARKER_FILE

    try:
        # Ensure parent directory exists
        activity_marker.parent.mkdir(parents=True, exist_ok=True)

        # Create or update the marker file
        activity_marker.touch()
        return True

    except OSError as e:
        logger.warning(f"Could not touch activity marker for task {task_id}: {e}")
        return False


def start_coding(
    task_id: str,
    base_dir: Path,
    state_dir: Path | None = None,
    base_branch: str | None = None,
) -> str:
    """
    Atomic transition from ready to coding state.

    This function performs the complete transition from "ready" to "coding" status:
    1. Acquires task lock
    2. Validates task is in "ready" status
    3. Creates a git worktree for the task
    4. Creates an activity marker file
    5. Updates task state to "coding"

    All operations are performed under lock to prevent race conditions.

    Args:
        task_id: Unique identifier for the task.
        base_dir: Project root directory containing the .worktrees folder.
        state_dir: Directory where task state files are stored. If None, uses
            base_dir / ".auto-claude" / "specs".
        base_branch: Base branch to create worktree from. If None, auto-detects.

    Returns:
        Action string indicating the result:
        - "success": Task successfully transitioned to coding state
        - "lock_failed": Could not acquire lock, retry later
        - "no_state": No state file found for task
        - "wrong_status": Task is not in "ready" status
        - "worktree_failed": Failed to create worktree
        - "max_retries": Task has exceeded maximum recovery attempts

    Example:
        result = start_coding("my-task", Path("/project"))
        if result == "success":
            # Task is now in coding state with worktree ready
            ...
        elif result == "lock_failed":
            # Retry next polling cycle
            ...
    """
    # Import here to avoid circular dependency
    from services.task_state import load_state, save_state, utc_now

    # Default state directory follows Auto-Claude convention
    if state_dir is None:
        state_dir = base_dir / ".auto-claude" / "specs"

    # Acquire lock before modifying state
    with task_lock(task_id, state_dir) as acquired:
        if not acquired:
            return START_CODING_LOCK_FAILED

        # Load current state
        state = load_state(task_id, state_dir)
        if state is None:
            logger.warning(f"NO_STATE {task_id}: no state file found, cannot start coding")
            return START_CODING_NO_STATE

        # Check if task has exceeded max recovery attempts
        if state.recovery_attempts >= MAX_RECOVERY_ATTEMPTS:
            logger.warning(
                f"MAX_RETRIES {task_id}: cannot start coding, task has exceeded "
                f"maximum recovery attempts ({state.recovery_attempts}/{MAX_RECOVERY_ATTEMPTS})"
            )
            return START_CODING_MAX_RETRIES

        # Validate task is in ready status
        if state.status != "ready":
            logger.warning(
                f"WRONG_STATUS {task_id}: cannot start coding, status is "
                f"'{state.status}' (expected 'ready')"
            )
            return START_CODING_WRONG_STATUS

        # Create the worktree
        if not _create_worktree(base_dir, task_id, base_branch):
            # Increment recovery attempts on failure
            state.recovery_attempts += 1
            state.last_activity = utc_now()
            save_state(state, state_dir)
            return START_CODING_WORKTREE_FAILED

        # Create activity marker
        touch_activity(task_id, base_dir)

        # Update state to coding
        state.status = "coding"
        state.last_activity = utc_now()
        save_state(state, state_dir)

        logger.info(
            f"START_CODING {task_id}: transitioned from 'ready' to 'coding', "
            f"worktree created at .worktrees/{task_id}/"
        )
        return START_CODING_SUCCESS