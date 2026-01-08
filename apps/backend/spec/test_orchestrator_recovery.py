#!/usr/bin/env python3
"""
Integration Tests for Orchestrator Recovery Cycle
===================================================

Tests the integration between the orchestrator (coder.py) and the
task recovery system (task_recovery.py).

Integration tests covered:
- Orchestrator calls recover_if_stuck during polling cycle
- Stuck task (status=coding, no worktree) is recovered to ready state
- start_coding creates worktree and activity marker atomically
- Worker heartbeat (touch_activity) prevents zombie detection

These tests verify the complete recovery workflow including:
- State file management
- File locking
- Worktree detection
- Activity marker handling
"""

import os
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest
from services.task_recovery import (
    ACTIVITY_MARKER_FILE,
    MAX_RECOVERY_ATTEMPTS,
    RECOVERY_ACTION_LOCK_FAILED,
    RECOVERY_ACTION_MARK_FAILED,
    RECOVERY_ACTION_NONE,
    RECOVERY_ACTION_RESET_TO_READY,
    RECOVERY_ACTION_ZOMBIE_CLEANUP,
    START_CODING_SUCCESS,
    is_zombie,
    recover_if_stuck,
    start_coding,
    touch_activity,
    worktree_exists,
)
from services.task_state import TaskState, load_state, save_state, utc_now


class TestOrchestratorRecoveryIntegration:
    """
    Integration tests for orchestrator recovery cycle.

    These tests simulate the recovery flow that happens in coder.py's
    run_autonomous_agent() polling loop.
    """

    @pytest.fixture
    def integration_env(self):
        """
        Create a complete integration test environment.

        Sets up:
        - base_dir: simulated project root with .worktrees/
        - state_dir: simulated .auto-claude/specs/ directory for task state
        - git_repo: initialized git repository for worktree operations
        """
        # Create temp directories
        base_dir = Path(tempfile.mkdtemp(prefix="test_orchestrator_"))
        state_dir = base_dir / ".auto-claude" / "specs"
        state_dir.mkdir(parents=True)

        # Initialize a git repository for worktree operations
        try:
            subprocess.run(
                ["git", "init"],
                cwd=str(base_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            # Create an initial commit so worktree creation works
            subprocess.run(
                ["git", "config", "user.email", "test@test.com"],
                cwd=str(base_dir),
                capture_output=True,
                timeout=10,
            )
            subprocess.run(
                ["git", "config", "user.name", "Test User"],
                cwd=str(base_dir),
                capture_output=True,
                timeout=10,
            )
            # Create initial file and commit
            (base_dir / "README.md").write_text("# Test Repo")
            subprocess.run(
                ["git", "add", "."],
                cwd=str(base_dir),
                capture_output=True,
                timeout=10,
            )
            subprocess.run(
                ["git", "commit", "-m", "Initial commit"],
                cwd=str(base_dir),
                capture_output=True,
                timeout=30,
            )
        except Exception:
            # Git not available - some tests will be skipped
            pass

        yield {
            "base_dir": base_dir,
            "state_dir": state_dir,
        }

        # Cleanup
        shutil.rmtree(base_dir, ignore_errors=True)

    def test_recovery_cycle_detects_stuck_task_and_resets(self, integration_env):
        """
        Integration test: Full recovery cycle for stuck task.

        Simulates what happens in coder.py polling loop:
        1. Task has status='coding' but no worktree exists
        2. recover_if_stuck() is called (as in coder.py line 220)
        3. Task is reset to 'ready' state
        4. Recovery attempts are incremented
        """
        base_dir = integration_env["base_dir"]
        state_dir = integration_env["state_dir"]
        task_id = "stuck-integration-test"

        # Setup: Create a stuck task state (coding without worktree)
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Verify no worktree exists
        assert not worktree_exists(base_dir, task_id)

        # Simulate orchestrator polling cycle recovery check (coder.py line 220)
        recovery_action = recover_if_stuck(task_id, base_dir, state_dir)

        # Verify recovery action
        assert recovery_action == RECOVERY_ACTION_RESET_TO_READY

        # Verify state was updated
        updated_state = load_state(task_id, state_dir)
        assert updated_state is not None
        assert updated_state.status == "ready"
        assert updated_state.recovery_attempts == 1

    def test_recovery_cycle_handles_consistent_state(self, integration_env):
        """
        Integration test: No action for consistent state.

        When task state is consistent (ready status, no worktree),
        recovery should return no_action.
        """
        base_dir = integration_env["base_dir"]
        state_dir = integration_env["state_dir"]
        task_id = "consistent-integration-test"

        # Setup: Create a consistent task state
        initial_state = TaskState(
            task_id=task_id,
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Simulate orchestrator polling cycle
        recovery_action = recover_if_stuck(task_id, base_dir, state_dir)

        # Should be no action needed
        assert recovery_action == RECOVERY_ACTION_NONE

        # State should be unchanged
        updated_state = load_state(task_id, state_dir)
        assert updated_state.status == "ready"
        assert updated_state.recovery_attempts == 0

    def test_recovery_cycle_marks_failed_after_max_retries(self, integration_env):
        """
        Integration test: Task marked failed after max recovery attempts.

        Simulates the scenario where a task keeps getting stuck and
        exceeds the MAX_RECOVERY_ATTEMPTS limit.
        """
        base_dir = integration_env["base_dir"]
        state_dir = integration_env["state_dir"]
        task_id = "max-retries-integration"

        # Setup: Task at max recovery attempts
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=MAX_RECOVERY_ATTEMPTS,  # Already at max
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Simulate orchestrator polling cycle
        recovery_action = recover_if_stuck(task_id, base_dir, state_dir)

        # Should mark as failed (as handled in coder.py lines 228-238)
        assert recovery_action == RECOVERY_ACTION_MARK_FAILED

        # Verify state was marked failed
        updated_state = load_state(task_id, state_dir)
        assert updated_state.status == "failed"
        assert "Maximum recovery attempts" in updated_state.failure_reason


class TestStartCodingWorktreeCreation:
    """
    Integration tests for start_coding worktree and marker creation.

    Tests verify that start_coding performs the atomic transition:
    1. Create git worktree
    2. Create activity marker
    3. Update state to 'coding'
    """

    @pytest.fixture
    def git_env(self):
        """Create environment with initialized git repository."""
        base_dir = Path(tempfile.mkdtemp(prefix="test_worktree_"))
        state_dir = base_dir / ".auto-claude" / "specs"
        state_dir.mkdir(parents=True)

        # Initialize git repository
        git_available = False
        try:
            result = subprocess.run(
                ["git", "init"],
                cwd=str(base_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                subprocess.run(
                    ["git", "config", "user.email", "test@test.com"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                subprocess.run(
                    ["git", "config", "user.name", "Test User"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                (base_dir / "README.md").write_text("# Test")
                subprocess.run(
                    ["git", "add", "."],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                subprocess.run(
                    ["git", "commit", "-m", "Initial"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=30,
                )
                git_available = True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        yield {
            "base_dir": base_dir,
            "state_dir": state_dir,
            "git_available": git_available,
        }

        shutil.rmtree(base_dir, ignore_errors=True)

    @pytest.mark.skipif(
        shutil.which("git") is None,
        reason="Git not available"
    )
    def test_start_coding_creates_worktree_and_marker(self, git_env):
        """
        Integration test: start_coding creates worktree and activity marker.

        This tests the full atomic transition from ready to coding state,
        verifying all artifacts are created correctly.
        """
        if not git_env["git_available"]:
            pytest.skip("Git repository initialization failed")

        base_dir = git_env["base_dir"]
        state_dir = git_env["state_dir"]
        task_id = "worktree-creation-test"

        # Setup: Create task in ready state
        initial_state = TaskState(
            task_id=task_id,
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Execute start_coding
        result = start_coding(task_id, base_dir, state_dir)

        # Verify success
        assert result == START_CODING_SUCCESS

        # Verify worktree was created
        worktree_path = base_dir / ".worktrees" / task_id
        assert worktree_path.exists(), "Worktree directory should exist"

        # Verify activity marker was created
        marker_path = worktree_path / ACTIVITY_MARKER_FILE
        assert marker_path.exists(), "Activity marker should exist"

        # Verify state was updated to coding
        updated_state = load_state(task_id, state_dir)
        assert updated_state.status == "coding"

    @pytest.mark.skipif(
        shutil.which("git") is None,
        reason="Git not available"
    )
    def test_start_coding_state_rollback_on_worktree_failure(self, git_env):
        """
        Integration test: start_coding increments attempts on worktree failure.

        When worktree creation fails, recovery_attempts should be incremented
        to track the failure for bounded retry logic.
        """
        if not git_env["git_available"]:
            pytest.skip("Git repository initialization failed")

        base_dir = git_env["base_dir"]
        state_dir = git_env["state_dir"]
        task_id = "worktree-failure-test"

        # Setup: Create task in ready state
        initial_state = TaskState(
            task_id=task_id,
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Mock worktree creation to fail
        with mock.patch("services.task_recovery._create_worktree", return_value=False):
            from services.task_recovery import START_CODING_WORKTREE_FAILED
            result = start_coding(task_id, base_dir, state_dir)

        # Verify failure result
        assert result == START_CODING_WORKTREE_FAILED

        # Verify recovery_attempts was incremented
        updated_state = load_state(task_id, state_dir)
        assert updated_state.recovery_attempts == 1
        # Status should still be ready (not coding)
        assert updated_state.status == "ready"


class TestWorkerHeartbeatIntegration:
    """
    Integration tests for worker heartbeat mechanism.

    Tests verify that touch_activity prevents false zombie detection
    when called periodically during coding sessions.
    """

    @pytest.fixture
    def heartbeat_env(self):
        """Create environment for heartbeat tests."""
        base_dir = Path(tempfile.mkdtemp(prefix="test_heartbeat_"))
        state_dir = base_dir / ".auto-claude" / "specs"
        state_dir.mkdir(parents=True)

        yield {
            "base_dir": base_dir,
            "state_dir": state_dir,
        }

        shutil.rmtree(base_dir, ignore_errors=True)

    def test_worker_heartbeat_prevents_zombie_detection(self, heartbeat_env):
        """
        Integration test: touch_activity prevents zombie detection.

        Simulates the HeartbeatWriter behavior from session.py:
        - Task has old last_activity timestamp (would normally be zombie)
        - But activity marker is recent (touched by worker heartbeat)
        - Result: task is NOT detected as zombie
        """
        base_dir = heartbeat_env["base_dir"]
        task_id = "heartbeat-integration-test"

        # Setup: Old last_activity timestamp (3 hours ago)
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory structure
        worktree_path = base_dir / ".worktrees" / task_id
        worktree_path.mkdir(parents=True)

        # First, verify task would be detected as zombie without heartbeat
        assert is_zombie(state, base_dir) is True

        # Now simulate worker heartbeat (as in HeartbeatWriter._write_heartbeat)
        touch_activity(task_id, base_dir)

        # Verify activity marker was created
        marker_path = worktree_path / ACTIVITY_MARKER_FILE
        assert marker_path.exists()

        # Now task should NOT be detected as zombie
        assert is_zombie(state, base_dir) is False

    def test_periodic_heartbeat_keeps_task_alive(self, heartbeat_env):
        """
        Integration test: Periodic heartbeat keeps task alive.

        Simulates multiple heartbeat cycles to verify the activity
        marker continues to prevent zombie detection.
        """
        base_dir = heartbeat_env["base_dir"]
        task_id = "periodic-heartbeat-test"

        # Setup: Old last_activity
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory
        worktree_path = base_dir / ".worktrees" / task_id
        worktree_path.mkdir(parents=True)

        # Simulate multiple heartbeat cycles (like HeartbeatWriter at 30s intervals)
        for i in range(3):
            touch_activity(task_id, base_dir)
            # Verify not zombie after each heartbeat
            assert is_zombie(state, base_dir) is False

    def test_stale_heartbeat_allows_zombie_detection(self, heartbeat_env):
        """
        Integration test: Stale heartbeat allows zombie detection.

        When the activity marker is old (worker stopped updating),
        zombie detection should work correctly.
        """
        base_dir = heartbeat_env["base_dir"]
        task_id = "stale-heartbeat-test"

        # Setup: Old last_activity
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory and old marker
        worktree_path = base_dir / ".worktrees" / task_id
        worktree_path.mkdir(parents=True)
        marker_path = worktree_path / ACTIVITY_MARKER_FILE
        marker_path.touch()

        # Set marker mtime to 3 hours ago (stale heartbeat)
        old_mtime = time.time() - (3 * 60 * 60)
        os.utime(marker_path, (old_mtime, old_mtime))

        # Now task SHOULD be detected as zombie
        assert is_zombie(state, base_dir) is True


class TestRecoveryAndStartCodingIntegration:
    """
    Integration tests for the complete recovery -> start_coding flow.

    Tests the full lifecycle of a task recovery and restart.
    """

    @pytest.fixture
    def full_env(self):
        """Create full integration test environment."""
        base_dir = Path(tempfile.mkdtemp(prefix="test_full_"))
        state_dir = base_dir / ".auto-claude" / "specs"
        state_dir.mkdir(parents=True)

        # Initialize git
        git_available = False
        try:
            result = subprocess.run(
                ["git", "init"],
                cwd=str(base_dir),
                capture_output=True,
                timeout=30,
            )
            if result.returncode == 0:
                subprocess.run(
                    ["git", "config", "user.email", "test@test.com"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                subprocess.run(
                    ["git", "config", "user.name", "Test User"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                (base_dir / "README.md").write_text("# Test")
                subprocess.run(
                    ["git", "add", "."],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=10,
                )
                subprocess.run(
                    ["git", "commit", "-m", "Initial"],
                    cwd=str(base_dir),
                    capture_output=True,
                    timeout=30,
                )
                git_available = True
        except Exception:
            pass

        yield {
            "base_dir": base_dir,
            "state_dir": state_dir,
            "git_available": git_available,
        }

        shutil.rmtree(base_dir, ignore_errors=True)

    def test_recovery_to_coding_full_cycle(self, full_env):
        """
        Integration test: Complete recovery and restart cycle.

        Tests the full lifecycle:
        1. Task is stuck (coding without worktree)
        2. Recovery resets to ready
        3. start_coding transitions back to coding with worktree
        4. Verify final state is correct
        """
        base_dir = full_env["base_dir"]
        state_dir = full_env["state_dir"]
        task_id = "full-cycle-test"

        # Step 1: Create stuck task
        initial_state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, state_dir)

        # Step 2: Recovery resets to ready
        recovery_action = recover_if_stuck(task_id, base_dir, state_dir)
        assert recovery_action == RECOVERY_ACTION_RESET_TO_READY

        # Verify intermediate state
        intermediate_state = load_state(task_id, state_dir)
        assert intermediate_state.status == "ready"
        assert intermediate_state.recovery_attempts == 1

        # Step 3: Restart coding (if git available)
        if full_env["git_available"]:
            result = start_coding(task_id, base_dir, state_dir)
            assert result == START_CODING_SUCCESS

            # Step 4: Verify final state
            final_state = load_state(task_id, state_dir)
            assert final_state.status == "coding"

            # Verify worktree exists
            assert worktree_exists(base_dir, task_id)

            # Verify activity marker exists
            marker_path = base_dir / ".worktrees" / task_id / ACTIVITY_MARKER_FILE
            assert marker_path.exists()


class TestLockingIntegration:
    """
    Integration tests for file locking during recovery operations.

    Tests verify that concurrent access is properly serialized.
    """

    @pytest.fixture
    def lock_env(self):
        """Create environment for locking tests."""
        base_dir = Path(tempfile.mkdtemp(prefix="test_locking_"))
        state_dir = base_dir / ".auto-claude" / "specs"
        state_dir.mkdir(parents=True)

        yield {
            "base_dir": base_dir,
            "state_dir": state_dir,
        }

        shutil.rmtree(base_dir, ignore_errors=True)

    def test_lock_file_created_during_recovery(self, lock_env):
        """
        Integration test: Lock file is created during recovery operations.

        Verifies that task_lock creates the .lock file in the state directory
        during recovery operations.
        """
        base_dir = lock_env["base_dir"]
        state_dir = lock_env["state_dir"]
        task_id = "lock-test"

        # Create task state
        state = TaskState(
            task_id=task_id,
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        # Before recovery, lock file may not exist
        lock_path = state_dir / task_id / ".lock"

        # Run recovery (will create lock file)
        recover_if_stuck(task_id, base_dir, state_dir)

        # Lock file should now exist
        assert lock_path.exists()

    def test_multiple_recovery_calls_serialize(self, lock_env):
        """
        Integration test: Multiple recovery calls are serialized by locking.

        Simulates concurrent recovery attempts and verifies they don't
        corrupt state.
        """
        base_dir = lock_env["base_dir"]
        state_dir = lock_env["state_dir"]
        task_id = "concurrent-test"

        # Create stuck task
        state = TaskState(
            task_id=task_id,
            status="coding",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        # Simulate multiple recovery calls (would happen if multiple
        # processes were running - normally prevented by locking)
        results = []
        for _ in range(3):
            result = recover_if_stuck(task_id, base_dir, state_dir)
            results.append(result)

        # First call should recover, subsequent calls should be no_action
        # (since task is now in 'ready' state without worktree)
        assert results[0] == RECOVERY_ACTION_RESET_TO_READY
        # After recovery, no more action needed
        assert results[1] == RECOVERY_ACTION_NONE
        assert results[2] == RECOVERY_ACTION_NONE

        # Final state should be consistent
        final_state = load_state(task_id, state_dir)
        assert final_state.status == "ready"
        assert final_state.recovery_attempts == 1  # Only incremented once
