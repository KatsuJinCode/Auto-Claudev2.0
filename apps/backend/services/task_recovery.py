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