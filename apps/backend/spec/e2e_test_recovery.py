#!/usr/bin/env python3
"""
Manual E2E Test Script: Stuck Task Recovery System
===================================================

This script performs end-to-end testing of the task recovery system:
1. Stuck task recovered to ready (status='coding', no worktree)
2. Zombie task cleaned up (worktree exists, no activity for 2+ hours)
3. Max retries causes permanent failure (recovery_attempts >= 5)

Run from apps/backend directory:
    python spec/e2e_test_recovery.py
"""

import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from services.task_recovery import (
    RECOVERY_ACTION_MARK_FAILED,
    RECOVERY_ACTION_RESET_TO_READY,
    RECOVERY_ACTION_ZOMBIE_CLEANUP,
    recover_if_stuck,
    touch_activity,
    worktree_exists,
)
from services.task_state import TaskState, load_state, save_state, utc_now


def print_header(title: str) -> None:
    """Print a formatted test header."""
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


def print_result(passed: bool, message: str) -> None:
    """Print a test result."""
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"  {status}: {message}")


def create_test_worktree(base_dir: Path, task_id: str) -> bool:
    """Create a worktree for testing (without full git branch setup)."""
    worktree_path = base_dir / ".worktrees" / task_id
    worktree_path.mkdir(parents=True, exist_ok=True)
    # Create a .git file to simulate worktree
    git_file = worktree_path / ".git"
    git_file.write_text(f"gitdir: {base_dir}/.git/worktrees/{task_id}")
    return True


def test_stuck_task_recovery() -> tuple[bool, str]:
    """
    Test Case 1: Stuck task recovered to ready

    Scenario:
    - Task has status='coding' in task_state.json
    - No worktree exists for the task

    Expected:
    - Task status reset to 'ready'
    - recovery_attempts incremented
    - Returns RECOVERY_ACTION_RESET_TO_READY
    """
    print_header("Test 1: Stuck Task Recovery (coding without worktree)")

    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir) / "project"
        state_dir = base_dir / ".auto-claude" / "specs"
        task_id = "test-stuck-task"

        # Setup: Create state directory
        state_dir.mkdir(parents=True, exist_ok=True)

        # Setup: Create task_state.json with status='coding'
        initial_state = TaskState(
            task_id=task_id,
            status="coding",  # Status is coding
            recovery_attempts=0,
            last_activity=utc_now(),
            failure_reason=None,
        )
        save_state(initial_state, state_dir)
        print(f"  Created task state: status='{initial_state.status}', attempts={initial_state.recovery_attempts}")

        # Verify: No worktree exists
        has_worktree = worktree_exists(base_dir, task_id)
        print(f"  Worktree exists: {has_worktree}")
        if has_worktree:
            return False, "Expected no worktree to exist"

        # Action: Run recovery
        print("  Running recover_if_stuck()...")
        action = recover_if_stuck(task_id, base_dir, state_dir)
        print(f"  Recovery action: {action}")

        # Verify: Action is reset_to_ready
        if action != RECOVERY_ACTION_RESET_TO_READY:
            return False, f"Expected '{RECOVERY_ACTION_RESET_TO_READY}', got '{action}'"

        # Verify: State updated correctly
        final_state = load_state(task_id, state_dir)
        if final_state is None:
            return False, "Failed to load final state"

        print(f"  Final state: status='{final_state.status}', attempts={final_state.recovery_attempts}")

        if final_state.status != "ready":
            return False, f"Expected status 'ready', got '{final_state.status}'"

        if final_state.recovery_attempts != 1:
            return False, f"Expected recovery_attempts=1, got {final_state.recovery_attempts}"

        return True, "Stuck task successfully recovered to ready state"


def test_zombie_task_cleanup() -> tuple[bool, str]:
    """
    Test Case 2: Zombie task cleaned up

    Scenario:
    - Task has status='coding' in task_state.json
    - Worktree exists for the task
    - last_activity timestamp is >2 hours old
    - No recent activity marker

    Expected:
    - Worktree removed (or attempted)
    - Task status reset to 'ready'
    - recovery_attempts incremented
    - Returns RECOVERY_ACTION_ZOMBIE_CLEANUP
    """
    print_header("Test 2: Zombie Task Cleanup (worktree exists, no activity)")

    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir) / "project"
        state_dir = base_dir / ".auto-claude" / "specs"
        task_id = "test-zombie-task"

        # Setup: Create directories
        state_dir.mkdir(parents=True, exist_ok=True)
        (base_dir / ".worktrees").mkdir(parents=True, exist_ok=True)

        # Setup: Create old timestamp (3 hours ago)
        old_time = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()

        # Setup: Create task_state.json with old last_activity
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=old_time,  # 3 hours old
            failure_reason=None,
        )
        save_state(initial_state, state_dir)
        print(f"  Created task state: status='{initial_state.status}', last_activity=3 hours ago")

        # Setup: Create worktree directory (simulated)
        create_test_worktree(base_dir, task_id)

        # Verify: Worktree exists
        has_worktree = worktree_exists(base_dir, task_id)
        print(f"  Worktree exists: {has_worktree}")
        if not has_worktree:
            return False, "Expected worktree to exist"

        # Action: Run recovery
        print("  Running recover_if_stuck()...")
        action = recover_if_stuck(task_id, base_dir, state_dir)
        print(f"  Recovery action: {action}")

        # Verify: Action is zombie_cleanup
        if action != RECOVERY_ACTION_ZOMBIE_CLEANUP:
            return False, f"Expected '{RECOVERY_ACTION_ZOMBIE_CLEANUP}', got '{action}'"

        # Verify: State updated correctly
        final_state = load_state(task_id, state_dir)
        if final_state is None:
            return False, "Failed to load final state"

        print(f"  Final state: status='{final_state.status}', attempts={final_state.recovery_attempts}")

        if final_state.status != "ready":
            return False, f"Expected status 'ready', got '{final_state.status}'"

        if final_state.recovery_attempts != 1:
            return False, f"Expected recovery_attempts=1, got {final_state.recovery_attempts}"

        return True, "Zombie task successfully cleaned up and recovered"


def test_max_retries_permanent_failure() -> tuple[bool, str]:
    """
    Test Case 3: Max retries causes permanent failure

    Scenario:
    - Task has recovery_attempts=5 (max)
    - Task is in coding status with no worktree (stuck)

    Expected:
    - Task status changed to 'failed'
    - failure_reason set
    - Returns RECOVERY_ACTION_MARK_FAILED
    """
    print_header("Test 3: Max Retries Causes Permanent Failure")

    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir) / "project"
        state_dir = base_dir / ".auto-claude" / "specs"
        task_id = "test-max-retries"

        # Setup: Create state directory
        state_dir.mkdir(parents=True, exist_ok=True)

        # Setup: Create task_state.json with recovery_attempts=5
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=5,  # Max retries reached
            last_activity=utc_now(),
            failure_reason=None,
        )
        save_state(initial_state, state_dir)
        print(f"  Created task state: status='{initial_state.status}', attempts={initial_state.recovery_attempts}")

        # Action: Run recovery
        print("  Running recover_if_stuck()...")
        action = recover_if_stuck(task_id, base_dir, state_dir)
        print(f"  Recovery action: {action}")

        # Verify: Action is mark_failed
        if action != RECOVERY_ACTION_MARK_FAILED:
            return False, f"Expected '{RECOVERY_ACTION_MARK_FAILED}', got '{action}'"

        # Verify: State updated correctly
        final_state = load_state(task_id, state_dir)
        if final_state is None:
            return False, "Failed to load final state"

        print(f"  Final state: status='{final_state.status}', failure_reason='{final_state.failure_reason}'")

        if final_state.status != "failed":
            return False, f"Expected status 'failed', got '{final_state.status}'"

        if final_state.failure_reason is None:
            return False, "Expected failure_reason to be set"

        if "Maximum recovery attempts" not in final_state.failure_reason:
            return False, f"Unexpected failure_reason: {final_state.failure_reason}"

        return True, "Task correctly marked as failed after max retries"


def test_activity_marker_prevents_zombie() -> tuple[bool, str]:
    """
    Test Case 4 (bonus): Activity marker prevents zombie detection

    Scenario:
    - Task has status='coding' with old last_activity
    - Worktree exists
    - Activity marker file exists and is recent

    Expected:
    - No recovery action taken (task is still active)
    """
    print_header("Test 4: Activity Marker Prevents False Zombie Detection")

    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir) / "project"
        state_dir = base_dir / ".auto-claude" / "specs"
        task_id = "test-active-task"

        # Setup: Create directories
        state_dir.mkdir(parents=True, exist_ok=True)

        # Setup: Create old timestamp (3 hours ago)
        old_time = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()

        # Setup: Create task_state.json with old last_activity
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=old_time,  # 3 hours old
            failure_reason=None,
        )
        save_state(initial_state, state_dir)
        print(f"  Created task state: status='{initial_state.status}', last_activity=3 hours ago")

        # Setup: Create worktree directory
        create_test_worktree(base_dir, task_id)

        # Setup: Create RECENT activity marker
        touch_activity(task_id, base_dir)
        print("  Created recent activity marker")

        # Verify: Worktree exists
        has_worktree = worktree_exists(base_dir, task_id)
        print(f"  Worktree exists: {has_worktree}")

        # Action: Run recovery
        print("  Running recover_if_stuck()...")
        action = recover_if_stuck(task_id, base_dir, state_dir)
        print(f"  Recovery action: {action}")

        # Verify: No action taken (activity marker is recent)
        if action == RECOVERY_ACTION_ZOMBIE_CLEANUP:
            return False, "Task incorrectly flagged as zombie despite recent activity marker"

        if action not in ("no_action",):
            return False, f"Expected 'no_action', got '{action}'"

        # Verify: State unchanged
        final_state = load_state(task_id, state_dir)
        if final_state is None:
            return False, "Failed to load final state"

        print(f"  Final state: status='{final_state.status}', attempts={final_state.recovery_attempts}")

        if final_state.status != "coding":
            return False, f"Expected status 'coding' (unchanged), got '{final_state.status}'"

        if final_state.recovery_attempts != 0:
            return False, f"Expected recovery_attempts=0 (unchanged), got {final_state.recovery_attempts}"

        return True, "Activity marker correctly prevented false zombie detection"


def main() -> int:
    """Run all E2E tests and report results."""
    print("\n" + "=" * 60)
    print("  MANUAL E2E TEST: Stuck Task Recovery System")
    print("=" * 60)
    print(f"  Test run: {datetime.now(timezone.utc).isoformat()}")

    tests = [
        test_stuck_task_recovery,
        test_zombie_task_cleanup,
        test_max_retries_permanent_failure,
        test_activity_marker_prevents_zombie,
    ]

    results = []
    for test_func in tests:
        try:
            passed, message = test_func()
            results.append((test_func.__name__, passed, message))
            print_result(passed, message)
        except Exception as e:
            results.append((test_func.__name__, False, str(e)))
            print_result(False, f"Exception: {e}")

    # Print summary
    print("\n" + "=" * 60)
    print("  TEST SUMMARY")
    print("=" * 60)

    passed_count = sum(1 for _, passed, _ in results if passed)
    total_count = len(results)

    for name, passed, message in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status}: {name}")

    print(f"\n  Total: {passed_count}/{total_count} tests passed")

    # Return exit code
    return 0 if passed_count == total_count else 1


if __name__ == "__main__":
    sys.exit(main())
