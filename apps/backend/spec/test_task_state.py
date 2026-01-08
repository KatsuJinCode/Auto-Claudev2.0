#!/usr/bin/env python3
"""
Unit Tests for Task State Module
================================

Tests the task_state.py module functionality including:
- TaskState dataclass creation
- utc_now timestamp generation
- save_state atomic file writes
- load_state with corrupt JSON handling
- UTC timestamp parsing
"""

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from services.task_state import TaskState, load_state, save_state, utc_now


class TestTaskStateDataclass:
    """Tests for TaskState dataclass creation."""

    def test_create_task_state_with_required_fields(self):
        """TaskState can be created with all required fields."""
        state = TaskState(
            task_id="test-001",
            status="ready",
            recovery_attempts=0,
            last_activity="2024-01-01T00:00:00+00:00",
        )

        assert state.task_id == "test-001"
        assert state.status == "ready"
        assert state.recovery_attempts == 0
        assert state.last_activity == "2024-01-01T00:00:00+00:00"
        assert state.failure_reason is None

    def test_create_task_state_with_failure_reason(self):
        """TaskState can be created with optional failure_reason."""
        state = TaskState(
            task_id="test-002",
            status="failed",
            recovery_attempts=5,
            last_activity="2024-01-01T00:00:00+00:00",
            failure_reason="Max recovery attempts exceeded",
        )

        assert state.status == "failed"
        assert state.failure_reason == "Max recovery attempts exceeded"

    def test_task_state_valid_statuses(self):
        """TaskState accepts all valid status values."""
        valid_statuses = ["backlog", "planning", "ready", "coding", "done", "failed"]

        for status in valid_statuses:
            state = TaskState(
                task_id="test",
                status=status,
                recovery_attempts=0,
                last_activity=utc_now(),
            )
            assert state.status == status


class TestUtcNow:
    """Tests for utc_now function."""

    def test_utc_now_returns_string(self):
        """utc_now returns a string."""
        result = utc_now()
        assert isinstance(result, str)

    def test_utc_now_returns_iso_format(self):
        """utc_now returns an ISO 8601 formatted string."""
        result = utc_now()
        # Should be parseable by datetime.fromisoformat
        parsed = datetime.fromisoformat(result)
        assert parsed is not None

    def test_utc_now_has_timezone_info(self):
        """utc_now returns a timestamp with UTC timezone info."""
        result = utc_now()
        parsed = datetime.fromisoformat(result)
        assert parsed.tzinfo is not None
        # Verify it's UTC (offset should be 0)
        assert parsed.utcoffset().total_seconds() == 0

    def test_utc_now_is_current_time(self):
        """utc_now returns approximately the current time."""
        before = datetime.now(timezone.utc)
        result = utc_now()
        after = datetime.now(timezone.utc)

        parsed = datetime.fromisoformat(result)
        assert before <= parsed <= after


class TestSaveState:
    """Tests for save_state function with atomic writes."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for state files."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_save_state_creates_file(self, temp_base_dir: Path):
        """save_state creates the task_state.json file."""
        state = TaskState(
            task_id="test-save",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        save_state(state, temp_base_dir)

        state_path = temp_base_dir / "test-save" / "task_state.json"
        assert state_path.exists()

    def test_save_state_creates_task_directory(self, temp_base_dir: Path):
        """save_state creates the task directory if it doesn't exist."""
        state = TaskState(
            task_id="new-task",
            status="backlog",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        save_state(state, temp_base_dir)

        task_dir = temp_base_dir / "new-task"
        assert task_dir.exists()
        assert task_dir.is_dir()

    def test_save_state_writes_valid_json(self, temp_base_dir: Path):
        """save_state writes valid JSON content."""
        state = TaskState(
            task_id="json-test",
            status="coding",
            recovery_attempts=2,
            last_activity="2024-01-01T12:00:00+00:00",
            failure_reason=None,
        )

        save_state(state, temp_base_dir)

        state_path = temp_base_dir / "json-test" / "task_state.json"
        content = json.loads(state_path.read_text())

        assert content["task_id"] == "json-test"
        assert content["status"] == "coding"
        assert content["recovery_attempts"] == 2
        assert content["last_activity"] == "2024-01-01T12:00:00+00:00"
        assert content["failure_reason"] is None

    def test_save_state_atomic_no_temp_file_remains(self, temp_base_dir: Path):
        """save_state doesn't leave temporary files after successful write."""
        state = TaskState(
            task_id="atomic-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        save_state(state, temp_base_dir)

        task_dir = temp_base_dir / "atomic-test"
        temp_files = list(task_dir.glob("*.tmp"))
        assert len(temp_files) == 0

    def test_save_state_overwrites_existing(self, temp_base_dir: Path):
        """save_state overwrites existing state file."""
        # Save initial state
        initial_state = TaskState(
            task_id="overwrite-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(initial_state, temp_base_dir)

        # Save updated state
        updated_state = TaskState(
            task_id="overwrite-test",
            status="coding",
            recovery_attempts=1,
            last_activity=utc_now(),
        )
        save_state(updated_state, temp_base_dir)

        # Verify updated content
        state_path = temp_base_dir / "overwrite-test" / "task_state.json"
        content = json.loads(state_path.read_text())

        assert content["status"] == "coding"
        assert content["recovery_attempts"] == 1


class TestLoadState:
    """Tests for load_state function with error handling."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for state files."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_load_state_returns_task_state(self, temp_base_dir: Path):
        """load_state returns a TaskState object."""
        # Create a valid state file
        state = TaskState(
            task_id="load-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, temp_base_dir)

        loaded = load_state("load-test", temp_base_dir)

        assert isinstance(loaded, TaskState)
        assert loaded.task_id == "load-test"
        assert loaded.status == "ready"

    def test_load_state_nonexistent_file_returns_none(self, temp_base_dir: Path):
        """load_state returns None for nonexistent file."""
        result = load_state("nonexistent-task", temp_base_dir)
        assert result is None

    def test_load_state_corrupt_json_returns_none(self, temp_base_dir: Path):
        """load_state returns None for corrupt JSON and logs error."""
        # Create task directory with corrupt JSON
        task_dir = temp_base_dir / "corrupt-task"
        task_dir.mkdir(parents=True)
        state_path = task_dir / "task_state.json"
        state_path.write_text("{ invalid json content }")

        result = load_state("corrupt-task", temp_base_dir)

        assert result is None

    def test_load_state_missing_required_field_returns_none(self, temp_base_dir: Path):
        """load_state returns None when required field is missing."""
        task_dir = temp_base_dir / "missing-field"
        task_dir.mkdir(parents=True)
        state_path = task_dir / "task_state.json"
        # Missing 'status' field
        state_path.write_text(json.dumps({
            "task_id": "missing-field",
            "recovery_attempts": 0,
            "last_activity": "2024-01-01T00:00:00+00:00",
        }))

        result = load_state("missing-field", temp_base_dir)

        assert result is None

    def test_load_state_preserves_all_fields(self, temp_base_dir: Path):
        """load_state correctly preserves all fields including failure_reason."""
        original = TaskState(
            task_id="full-test",
            status="failed",
            recovery_attempts=5,
            last_activity="2024-06-15T10:30:00+00:00",
            failure_reason="Max retries exceeded",
        )
        save_state(original, temp_base_dir)

        loaded = load_state("full-test", temp_base_dir)

        assert loaded.task_id == original.task_id
        assert loaded.status == original.status
        assert loaded.recovery_attempts == original.recovery_attempts
        assert loaded.last_activity == original.last_activity
        assert loaded.failure_reason == original.failure_reason

    def test_load_state_handles_null_failure_reason(self, temp_base_dir: Path):
        """load_state handles null failure_reason correctly."""
        task_dir = temp_base_dir / "null-reason"
        task_dir.mkdir(parents=True)
        state_path = task_dir / "task_state.json"
        state_path.write_text(json.dumps({
            "task_id": "null-reason",
            "status": "ready",
            "recovery_attempts": 0,
            "last_activity": "2024-01-01T00:00:00+00:00",
            "failure_reason": None,
        }))

        loaded = load_state("null-reason", temp_base_dir)

        assert loaded is not None
        assert loaded.failure_reason is None


class TestUtcTimestampParsing:
    """Tests for UTC timestamp handling and parsing."""

    def test_parse_utc_timestamp_with_timezone(self):
        """Timestamps with timezone info are parsed correctly."""
        timestamp = "2024-06-15T10:30:00+00:00"
        parsed = datetime.fromisoformat(timestamp)

        assert parsed.tzinfo is not None
        assert parsed.year == 2024
        assert parsed.month == 6
        assert parsed.day == 15
        assert parsed.hour == 10
        assert parsed.minute == 30

    def test_parse_naive_timestamp_and_add_utc(self):
        """Naive timestamps can be converted to UTC."""
        naive_timestamp = "2024-06-15T10:30:00"
        parsed = datetime.fromisoformat(naive_timestamp)

        # Initially no timezone
        assert parsed.tzinfo is None

        # Add UTC timezone
        utc_parsed = parsed.replace(tzinfo=timezone.utc)

        assert utc_parsed.tzinfo is not None
        assert utc_parsed.utcoffset().total_seconds() == 0

    def test_utc_now_timestamp_roundtrip(self):
        """Timestamps from utc_now can be saved and loaded correctly."""
        timestamp = utc_now()

        # Simulate save/load by parsing
        parsed = datetime.fromisoformat(timestamp)

        # Verify it's a valid UTC timestamp
        assert parsed.tzinfo is not None
        assert parsed.utcoffset().total_seconds() == 0

    def test_compare_timestamps_from_different_sources(self):
        """Timestamps can be compared for ordering."""
        earlier = "2024-01-01T00:00:00+00:00"
        later = "2024-12-31T23:59:59+00:00"

        earlier_dt = datetime.fromisoformat(earlier)
        later_dt = datetime.fromisoformat(later)

        assert earlier_dt < later_dt


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    @pytest.fixture
    def temp_base_dir(self):
        """Create a temporary directory for state files."""
        temp_path = Path(tempfile.mkdtemp())
        yield temp_path
        shutil.rmtree(temp_path, ignore_errors=True)

    def test_empty_json_file_returns_none(self, temp_base_dir: Path):
        """load_state returns None for empty JSON file."""
        task_dir = temp_base_dir / "empty-json"
        task_dir.mkdir(parents=True)
        state_path = task_dir / "task_state.json"
        state_path.write_text("")

        result = load_state("empty-json", temp_base_dir)

        assert result is None

    def test_task_id_with_special_characters(self, temp_base_dir: Path):
        """TaskState handles task_id with special characters."""
        task_id = "spec-001-feature"
        state = TaskState(
            task_id=task_id,
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        save_state(state, temp_base_dir)
        loaded = load_state(task_id, temp_base_dir)

        assert loaded is not None
        assert loaded.task_id == task_id

    def test_save_state_with_path_object(self, temp_base_dir: Path):
        """save_state works with Path object as base_dir."""
        state = TaskState(
            task_id="path-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        # base_dir is already a Path object
        save_state(state, temp_base_dir)

        state_path = temp_base_dir / "path-test" / "task_state.json"
        assert state_path.exists()

    def test_save_state_with_string_path(self, temp_base_dir: Path):
        """save_state works with string as base_dir."""
        state = TaskState(
            task_id="string-path-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )

        # Pass string path instead of Path object
        save_state(state, str(temp_base_dir))

        state_path = temp_base_dir / "string-path-test" / "task_state.json"
        assert state_path.exists()

    def test_load_state_with_string_path(self, temp_base_dir: Path):
        """load_state works with string as base_dir."""
        state = TaskState(
            task_id="string-load-test",
            status="ready",
            recovery_attempts=0,
            last_activity=utc_now(),
        )
        save_state(state, temp_base_dir)

        # Load with string path
        loaded = load_state("string-load-test", str(temp_base_dir))

        assert loaded is not None
        assert loaded.task_id == "string-load-test"
