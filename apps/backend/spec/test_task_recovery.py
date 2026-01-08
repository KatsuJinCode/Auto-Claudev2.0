#!/usr/bin/env python3
"""
Unit Tests for Task Recovery Module
====================================

Tests the task_recovery.py module functionality including:
- task_lock context manager acquisition and timeout
- worktree_exists detection
- is_zombie threshold and activity marker checks
- recover_if_stuck all 4 recovery cases
- max retries enforcement
- touch_activity marker updates
- start_coding atomic transition
"""

import json
import os
import shutil
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest
from services.task_recovery import (
    ACTIVITY_MARKER_FILE,
    LOCK_TIMEOUT_SECONDS,
    MAX_RECOVERY_ATTEMPTS,
    RECOVERY_ACTION_LOCK_FAILED,
    RECOVERY_ACTION_MARK_FAILED,
    RECOVERY_ACTION_NO_STATE,
    RECOVERY_ACTION_NONE,
    RECOVERY_ACTION_RESET_TO_BACKLOG,
    RECOVERY_ACTION_RESET_TO_READY,
    RECOVERY_ACTION_UPDATE_TO_CODING,
    RECOVERY_ACTION_ZOMBIE_CLEANUP,
    START_CODING_LOCK_FAILED,
    START_CODING_MAX_RETRIES,
    START_CODING_NO_STATE,
    START_CODING_SUCCESS,
    START_CODING_WORKTREE_FAILED,
    START_CODING_WRONG_STATUS,
    ZOMBIE_THRESHOLD_HOURS,
    is_zombie,
    recover_if_stuck,
    start_coding,
    task_lock,
    touch_activity,
    worktree_exists,
)
from services.task_state import TaskState, save_state, utc_now


class TestTaskLockAcquisition:
    """Tests for task_lock context manager acquisition."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for lock files."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_task_lock_acquisition_success(self, temp_base_dir: Path):
        """task_lock yields True when lock is acquired successfully."""
        with task_lock("test-task", temp_base_dir) as acquired:
            assert acquired is True

    def test_task_lock_creates_lock_file(self, temp_base_dir: Path):
        """task_lock creates the .lock file in task directory."""
        with task_lock("lock-file-test", temp_base_dir) as acquired:
            assert acquired is True
            lock_path = temp_base_dir / "lock-file-test" / ".lock"
            assert lock_path.exists()

    def test_task_lock_creates_task_directory(self, temp_base_dir: Path):
        """task_lock creates the task directory if it doesn't exist."""
        task_dir = temp_base_dir / "new-task"
        assert not task_dir.exists()

        with task_lock("new-task", temp_base_dir) as acquired:
            assert acquired is True
            assert task_dir.exists()
            assert task_dir.is_dir()

    def test_task_lock_reacquire_after_release(self, temp_base_dir: Path):
        """task_lock can be acquired again after release."""
        # First acquisition
        with task_lock("reacquire-test", temp_base_dir) as acquired:
            assert acquired is True

        # Second acquisition should succeed
        with task_lock("reacquire-test", temp_base_dir) as acquired:
            assert acquired is True

    def test_task_lock_different_tasks_independent(self, temp_base_dir: Path):
        """Different tasks have independent locks."""
        with task_lock("task-a", temp_base_dir) as acquired_a:
            assert acquired_a is True
            # Can acquire a different task's lock while holding this one
            with task_lock("task-b", temp_base_dir) as acquired_b:
                assert acquired_b is True


class TestTaskLockTimeout:
    """Tests for task_lock timeout behavior."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for lock files."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_task_lock_timeout_yields_false(self, temp_base_dir: Path):
        """task_lock yields False when lock cannot be acquired (mocked timeout)."""
        import portalocker

        # Mock LockException to simulate timeout
        with mock.patch("services.task_recovery.portalocker.Lock") as mock_lock:
            mock_instance = mock.MagicMock()
            mock_instance.acquire.side_effect = portalocker.LockException("Timeout")
            mock_lock.return_value = mock_instance

            with task_lock("timeout-test", temp_base_dir) as acquired:
                assert acquired is False

    def test_lock_timeout_constant_is_30_seconds(self):
        """Lock timeout constant is set to 30 seconds per spec."""
        assert LOCK_TIMEOUT_SECONDS == 30


class TestWorktreeExists:
    """Tests for worktree_exists function."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for worktree tests."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_worktree_exists_returns_false_for_nonexistent(self, temp_base_dir: Path):
        """worktree_exists returns False when worktree doesn't exist."""
        result = worktree_exists(temp_base_dir, "nonexistent-task")
        assert result is False

    def test_worktree_exists_returns_true_for_directory(self, temp_base_dir: Path):
        """worktree_exists returns True when worktree directory exists."""
        worktree_path = temp_base_dir / ".worktrees" / "existing-task"
        worktree_path.mkdir(parents=True)

        result = worktree_exists(temp_base_dir, "existing-task")
        assert result is True

    def test_worktree_exists_with_git_file(self, temp_base_dir: Path):
        """worktree_exists returns True for directory with .git file (worktree pointer)."""
        worktree_path = temp_base_dir / ".worktrees" / "git-file-task"
        worktree_path.mkdir(parents=True)
        # Create .git file (worktree pointer)
        git_file = worktree_path / ".git"
        git_file.write_text("gitdir: /path/to/main/repo/.git/worktrees/git-file-task")

        result = worktree_exists(temp_base_dir, "git-file-task")
        assert result is True

    def test_worktree_exists_with_git_directory(self, temp_base_dir: Path):
        """worktree_exists returns True for directory with .git directory (edge case)."""
        worktree_path = temp_base_dir / ".worktrees" / "git-dir-task"
        worktree_path.mkdir(parents=True)
        # Create .git directory (unusual but possible)
        git_dir = worktree_path / ".git"
        git_dir.mkdir()

        result = worktree_exists(temp_base_dir, "git-dir-task")
        assert result is True

    def test_worktree_exists_empty_directory(self, temp_base_dir: Path):
        """worktree_exists returns True for empty worktree directory."""
        worktree_path = temp_base_dir / ".worktrees" / "empty-task"
        worktree_path.mkdir(parents=True)
        # Empty directory, but exists

        result = worktree_exists(temp_base_dir, "empty-task")
        assert result is True


class TestIsZombieThreshold:
    """Tests for is_zombie function threshold behavior."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for zombie tests."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_zombie_threshold_constant_is_2_hours(self):
        """Zombie threshold constant is set to 2 hours per spec."""
        assert ZOMBIE_THRESHOLD_HOURS == 2

    def test_is_zombie_returns_true_for_old_activity(self, temp_base_dir: Path):
        """is_zombie returns True when last_activity is older than 2 hours."""
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="old-task",
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        result = is_zombie(state, temp_base_dir)
        assert result is True

    def test_is_zombie_returns_false_for_recent_activity(self, temp_base_dir: Path):
        """is_zombie returns False when last_activity is recent."""
        recent_time = datetime.now(timezone.utc) - timedelta(minutes=30)
        state = TaskState(
            task_id="recent-task",
            status="coding",
            recovery_attempts=0,
            last_activity=recent_time.isoformat(),
        )

        result = is_zombie(state, temp_base_dir)
        assert result is False

    def test_is_zombie_boundary_exactly_2_hours(self, temp_base_dir: Path):
        """is_zombie returns False when exactly at 2-hour threshold."""
        # Just under 2 hours should not be zombie
        boundary_time = datetime.now(timezone.utc) - timedelta(hours=1, minutes=59)
        state = TaskState(
            task_id="boundary-task",
            status="coding",
            recovery_attempts=0,
            last_activity=boundary_time.isoformat(),
        )

        result = is_zombie(state, temp_base_dir)
        assert result is False

    def test_is_zombie_invalid_timestamp_returns_true(self, temp_base_dir: Path):
        """is_zombie returns True for invalid timestamp (treated as zombie)."""
        state = TaskState(
            task_id="invalid-ts-task",
            status="coding",
            recovery_attempts=0,
            last_activity="not-a-valid-timestamp",
        )

        result = is_zombie(state, temp_base_dir)
        assert result is True

    def test_is_zombie_naive_timestamp_converted_to_utc(self, temp_base_dir: Path):
        """is_zombie handles naive timestamps by converting to UTC."""
        # Naive timestamp (no timezone info)
        recent_naive = datetime.now(timezone.utc) - timedelta(minutes=30)
        naive_str = recent_naive.replace(tzinfo=None).isoformat()

        state = TaskState(
            task_id="naive-ts-task",
            status="coding",
            recovery_attempts=0,
            last_activity=naive_str,
        )

        # Should not be zombie because it's recent
        result = is_zombie(state, temp_base_dir)
        assert result is False


class TestIsZombieActivityMarker:
    """Tests for is_zombie activity marker checks."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory with worktree structure."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_is_zombie_recent_marker_prevents_detection(self, temp_base_dir: Path):
        """Recent activity marker prevents zombie detection."""
        # Old last_activity but recent marker
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="marker-recent",
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory with activity marker
        worktree_path = temp_base_dir / ".worktrees" / "marker-recent"
        worktree_path.mkdir(parents=True)
        marker_path = worktree_path / ACTIVITY_MARKER_FILE
        marker_path.touch()  # Fresh marker

        result = is_zombie(state, temp_base_dir)
        assert result is False

    def test_is_zombie_old_marker_allows_detection(self, temp_base_dir: Path):
        """Old activity marker allows zombie detection."""
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="marker-old",
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory with old activity marker
        worktree_path = temp_base_dir / ".worktrees" / "marker-old"
        worktree_path.mkdir(parents=True)
        marker_path = worktree_path / ACTIVITY_MARKER_FILE
        marker_path.touch()

        # Set marker mtime to 3 hours ago
        old_mtime = time.time() - (3 * 60 * 60)
        os.utime(marker_path, (old_mtime, old_mtime))

        result = is_zombie(state, temp_base_dir)
        assert result is True

    def test_is_zombie_missing_marker_with_old_activity(self, temp_base_dir: Path):
        """Missing activity marker with old activity causes zombie detection."""
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="no-marker",
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )

        # Create worktree directory without activity marker
        worktree_path = temp_base_dir / ".worktrees" / "no-marker"
        worktree_path.mkdir(parents=True)
        # No marker file created

        result = is_zombie(state, temp_base_dir)
        assert result is True


class TestRecoverIfStuckCodingNoWorktree:
    """Tests for recover_if_stuck: Case 1 - coding without worktree."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_recover_coding_no_worktree_resets_to_ready(self, temp_dirs):
        """Task with status='coding' but no worktree is reset to 'ready'."""
        base_dir, state_dir = temp_dirs

        # Create state with coding status but no worktree
        state = TaskState(
            task_id="stuck-task",
            status="coding",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        # No worktree exists at base_dir/.worktrees/stuck-task

        result = recover_if_stuck("stuck-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_RESET_TO_READY

    def test_recover_coding_no_worktree_increments_attempts(self, temp_dirs):
        """Recovery increments recovery_attempts counter."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="increment-test",
            status="coding",
            recovery_attempts=1,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        recover_if_stuck("increment-test", base_dir, state_dir)

        # Load and verify attempts incremented
        from services.task_state import load_state

        updated = load_state("increment-test", state_dir)
        assert updated.recovery_attempts == 2


class TestRecoverIfStuckZombie:
    """Tests for recover_if_stuck: Case 2 - zombie task cleanup."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_recover_zombie_task_resets_to_ready(self, temp_dirs):
        """Zombie task is reset to 'ready' and worktree removal attempted."""
        base_dir, state_dir = temp_dirs

        # Create old state (zombie)
        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="zombie-task",
            status="coding",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )
        save_state(state, state_dir)

        # Create worktree directory (but no git repo - cleanup will skip)
        worktree_path = base_dir / ".worktrees" / "zombie-task"
        worktree_path.mkdir(parents=True)

        result = recover_if_stuck("zombie-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_ZOMBIE_CLEANUP

        # Verify state was updated
        from services.task_state import load_state

        updated = load_state("zombie-task", state_dir)
        assert updated.status == "ready"
        assert updated.recovery_attempts == 1


class TestRecoverIfStuckWorktreeWithoutCoding:
    """Tests for recover_if_stuck: Case 3 - worktree exists but status is ready."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_recover_worktree_without_coding_syncs_to_coding(self, temp_dirs):
        """Task with worktree but status='ready' is updated to 'coding'."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="sync-task",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        # Create worktree directory
        worktree_path = base_dir / ".worktrees" / "sync-task"
        worktree_path.mkdir(parents=True)

        result = recover_if_stuck("sync-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_UPDATE_TO_CODING

        # Verify state was updated
        from services.task_state import load_state

        updated = load_state("sync-task", state_dir)
        assert updated.status == "coding"
        # Sync doesn't increment recovery_attempts
        assert updated.recovery_attempts == 0


class TestRecoverIfStuckPlanningStalled:
    """Tests for recover_if_stuck: Case 4 - planning stalled."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_recover_planning_stalled_resets_to_backlog(self, temp_dirs):
        """Planning task stalled >2 hours is reset to 'backlog'."""
        base_dir, state_dir = temp_dirs

        old_time = datetime.now(timezone.utc) - timedelta(hours=3)
        state = TaskState(
            task_id="stalled-planning",
            status="planning",
            recovery_attempts=0,
            last_activity=old_time.isoformat(),
        )
        save_state(state, state_dir)

        result = recover_if_stuck("stalled-planning", base_dir, state_dir)

        assert result == RECOVERY_ACTION_RESET_TO_BACKLOG

        # Verify state was updated
        from services.task_state import load_state

        updated = load_state("stalled-planning", state_dir)
        assert updated.status == "backlog"
        assert updated.recovery_attempts == 1


class TestRecoverIfStuckMaxRetries:
    """Tests for recover_if_stuck: max retries enforcement."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_max_recovery_attempts_constant_is_5(self):
        """Max recovery attempts constant is set to 5 per spec."""
        assert MAX_RECOVERY_ATTEMPTS == 5

    def test_recover_max_retries_marks_failed(self, temp_dirs):
        """Task with 5 recovery attempts is marked as 'failed'."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="max-retries-task",
            status="coding",
            recovery_attempts=5,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        result = recover_if_stuck("max-retries-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_MARK_FAILED

        # Verify state was marked failed
        from services.task_state import load_state

        updated = load_state("max-retries-task", state_dir)
        assert updated.status == "failed"
        assert "Maximum recovery attempts" in updated.failure_reason

    def test_recover_already_failed_no_action(self, temp_dirs):
        """Already failed task returns no_action."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="already-failed",
            status="failed",
            recovery_attempts=5,
            last_activity=utc_now(),
            failure_reason="Previous failure",
        )
        save_state(state, state_dir)

        result = recover_if_stuck("already-failed", base_dir, state_dir)

        assert result == RECOVERY_ACTION_NONE

    def test_recover_done_task_no_action(self, temp_dirs):
        """Done task returns no_action."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="done-task",
            status="done",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        result = recover_if_stuck("done-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_NONE


class TestRecoverIfStuckEdgeCases:
    """Tests for recover_if_stuck edge cases."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for recovery tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_recover_no_state_returns_no_state(self, temp_dirs):
        """Missing state file returns 'no_state' action."""
        base_dir, state_dir = temp_dirs

        result = recover_if_stuck("nonexistent-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_NO_STATE

    def test_recover_lock_failed_returns_lock_failed(self, temp_dirs):
        """Lock failure returns 'lock_failed' action."""
        base_dir, state_dir = temp_dirs

        import portalocker

        # Mock lock acquisition failure
        with mock.patch("services.task_recovery.task_lock") as mock_lock:
            mock_context = mock.MagicMock()
            mock_context.__enter__ = mock.MagicMock(return_value=False)
            mock_context.__exit__ = mock.MagicMock(return_value=False)
            mock_lock.return_value = mock_context

            result = recover_if_stuck("lock-fail-task", base_dir, state_dir)

            assert result == RECOVERY_ACTION_LOCK_FAILED

    def test_recover_consistent_state_no_action(self, temp_dirs):
        """Consistent state (coding with recent activity and worktree) returns no_action."""
        base_dir, state_dir = temp_dirs

        recent_time = datetime.now(timezone.utc) - timedelta(minutes=10)
        state = TaskState(
            task_id="consistent-task",
            status="coding",
            recovery_attempts=0,
            last_activity=recent_time.isoformat(),
        )
        save_state(state, state_dir)

        # Create worktree and activity marker
        worktree_path = base_dir / ".worktrees" / "consistent-task"
        worktree_path.mkdir(parents=True)
        (worktree_path / ACTIVITY_MARKER_FILE).touch()

        result = recover_if_stuck("consistent-task", base_dir, state_dir)

        assert result == RECOVERY_ACTION_NONE


class TestTouchActivity:
    """Tests for touch_activity function."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for activity marker tests."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_touch_activity_creates_marker(self, temp_base_dir: Path):
        """touch_activity creates the .task_activity marker file."""
        result = touch_activity("new-activity-task", temp_base_dir)

        assert result is True
        marker_path = temp_base_dir / ".worktrees" / "new-activity-task" / ACTIVITY_MARKER_FILE
        assert marker_path.exists()

    def test_touch_activity_creates_parent_dirs(self, temp_base_dir: Path):
        """touch_activity creates parent directories if needed."""
        worktree_path = temp_base_dir / ".worktrees" / "parent-dirs-task"
        assert not worktree_path.exists()

        result = touch_activity("parent-dirs-task", temp_base_dir)

        assert result is True
        assert worktree_path.exists()

    def test_touch_activity_updates_mtime(self, temp_base_dir: Path):
        """touch_activity updates marker modification time."""
        # Create marker first
        touch_activity("mtime-task", temp_base_dir)
        marker_path = temp_base_dir / ".worktrees" / "mtime-task" / ACTIVITY_MARKER_FILE

        # Set old mtime
        old_mtime = time.time() - 3600
        os.utime(marker_path, (old_mtime, old_mtime))
        old_stat_mtime = marker_path.stat().st_mtime

        # Touch again
        time.sleep(0.1)  # Ensure time difference
        touch_activity("mtime-task", temp_base_dir)

        new_stat_mtime = marker_path.stat().st_mtime
        assert new_stat_mtime > old_stat_mtime

    def test_touch_activity_returns_true_on_success(self, temp_base_dir: Path):
        """touch_activity returns True on successful touch."""
        result = touch_activity("success-task", temp_base_dir)
        assert result is True


class TestStartCoding:
    """Tests for start_coding atomic transition."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary directories for start_coding tests."""
        base_dir = Path(tempfile.mkdtemp())
        state_dir = Path(tempfile.mkdtemp())
        yield base_dir, state_dir
        shutil.rmtree(base_dir, ignore_errors=True)
        shutil.rmtree(state_dir, ignore_errors=True)

    def test_start_coding_no_state_returns_no_state(self, temp_dirs):
        """start_coding returns 'no_state' when state file doesn't exist."""
        base_dir, state_dir = temp_dirs

        result = start_coding("nonexistent-task", base_dir, state_dir)

        assert result == START_CODING_NO_STATE

    def test_start_coding_wrong_status_returns_wrong_status(self, temp_dirs):
        """start_coding returns 'wrong_status' when task is not 'ready'."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="coding-task",
            status="coding",  # Already coding
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        result = start_coding("coding-task", base_dir, state_dir)

        assert result == START_CODING_WRONG_STATUS

    def test_start_coding_max_retries_returns_max_retries(self, temp_dirs):
        """start_coding returns 'max_retries' when attempts exceeded."""
        base_dir, state_dir = temp_dirs

        state = TaskState(
            task_id="maxed-out-task",
            status="ready",
            recovery_attempts=5,
            last_activity=utc_now(),
        )
        save_state(state, state_dir)

        result = start_coding("maxed-out-task", base_dir, state_dir)

        assert result == START_CODING_MAX_RETRIES

    def test_start_coding_lock_failed_returns_lock_failed(self, temp_dirs):
        """start_coding returns 'lock_failed' when lock cannot be acquired."""
        base_dir, state_dir = temp_dirs

        # Mock lock acquisition failure
        with mock.patch("services.task_recovery.task_lock") as mock_lock:
            mock_context = mock.MagicMock()
            mock_context.__enter__ = mock.MagicMock(return_value=False)
            mock_context.__exit__ = mock.MagicMock(return_value=False)
            mock_lock.return_value = mock_context

            result = start_coding("lock-fail-task", base_dir, state_dir)

            assert result == START_CODING_LOCK_FAILED


class TestRecoveryActionConstants:
    """Tests for recovery action constant values."""

    def test_recovery_action_constants_defined(self):
        """All recovery action constants are defined."""
        assert RECOVERY_ACTION_NONE == "no_action"
        assert RECOVERY_ACTION_RESET_TO_READY == "reset_to_ready"
        assert RECOVERY_ACTION_RESET_TO_BACKLOG == "reset_to_backlog"
        assert RECOVERY_ACTION_UPDATE_TO_CODING == "update_to_coding"
        assert RECOVERY_ACTION_MARK_FAILED == "mark_failed"
        assert RECOVERY_ACTION_ZOMBIE_CLEANUP == "zombie_cleanup"
        assert RECOVERY_ACTION_LOCK_FAILED == "lock_failed"
        assert RECOVERY_ACTION_NO_STATE == "no_state"

    def test_start_coding_constants_defined(self):
        """All start_coding action constants are defined."""
        assert START_CODING_SUCCESS == "success"
        assert START_CODING_LOCK_FAILED == "lock_failed"
        assert START_CODING_NO_STATE == "no_state"
        assert START_CODING_WRONG_STATUS == "wrong_status"
        assert START_CODING_WORKTREE_FAILED == "worktree_failed"
        assert START_CODING_MAX_RETRIES == "max_retries"
