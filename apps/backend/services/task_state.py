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

from dataclasses import dataclass


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
