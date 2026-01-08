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
from pathlib import Path

import portalocker

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
