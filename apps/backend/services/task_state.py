#!/usr/bin/env python3
"""
Task State Management
=====================

Defines the TaskState dataclass for tracking task lifecycle and recovery state.

Task statuses:
- backlog: Task is queued but not started
- planning: Task is being planned
- ready: Task is ready to start coding
- coding: Task is actively being worked on
- done: Task completed successfully
- failed: Task failed after max recovery attempts
"""

import json
import logging
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class TaskState:
    """
    State information for a task.

    Attributes:
        task_id: Unique identifier for the task (e.g., spec folder name)
        status: Current task status (backlog, planning, ready, coding, done, failed)
        recovery_attempts: Number of times this task has been recovered from stuck state
        last_activity: UTC ISO timestamp of last activity on this task
        failure_reason: Reason for failure if status is 'failed', None otherwise
    """

    task_id: str
    status: str
    recovery_attempts: int
    last_activity: str
    failure_reason: str | None = None


def utc_now() -> str:
    """
    Get current UTC time as ISO string.

    Returns:
        ISO 8601 formatted UTC timestamp string.
    """
    return datetime.now(timezone.utc).isoformat()


def save_state(state: TaskState, base_dir: str | Path) -> None:
    """
    Save task state to JSON file atomically.

    Uses temp file + os.replace() for atomic writes to prevent
    state corruption from process crashes mid-write.

    Args:
        state: The TaskState to save.
        base_dir: Base directory where task state files are stored.
    """
    base_path = Path(base_dir)
    task_dir = base_path / state.task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    state_path = task_dir / "task_state.json"
    temp_path = state_path.with_suffix(".tmp")

    try:
        temp_path.write_text(json.dumps(asdict(state), indent=2))
        os.replace(temp_path, state_path)
    except Exception as e:
        logger.error(f"Failed to save state for task {state.task_id}: {e}")
        # Clean up temp file if it exists
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass
        raise


def load_state(task_id: str, base_dir: str | Path) -> TaskState | None:
    """
    Load task state from JSON file.

    Handles corrupt JSON gracefully by returning None and logging error.

    Args:
        task_id: The task identifier.
        base_dir: Base directory where task state files are stored.

    Returns:
        TaskState if successfully loaded, None if file doesn't exist or is corrupt.
    """
    base_path = Path(base_dir)
    state_path = base_path / task_id / "task_state.json"

    if not state_path.exists():
        return None

    try:
        data = json.loads(state_path.read_text())
        return TaskState(
            task_id=data["task_id"],
            status=data["status"],
            recovery_attempts=data["recovery_attempts"],
            last_activity=data["last_activity"],
            failure_reason=data.get("failure_reason"),
        )
    except json.JSONDecodeError as e:
        logger.error(f"Corrupt JSON in state file for task {task_id}: {e}")
        return None
    except KeyError as e:
        logger.error(f"Missing required field in state file for task {task_id}: {e}")
        return None
    except Exception as e:
        logger.error(f"Failed to load state for task {task_id}: {e}")
        return None
