"""
Pipeline Module
================

Refactored spec creation pipeline with modular components.

Components:
- models: Data structures and utility functions
- agent_runner: Agent execution logic
- orchestrator: Main SpecOrchestrator class
"""

from init import init_auto_claude_dir

from .models import get_spec_dir_worktree_aware, get_specs_dir, list_all_specs_worktree_aware
from .orchestrator import SpecOrchestrator

__all__ = [
    "SpecOrchestrator",
    "get_specs_dir",
    "get_spec_dir_worktree_aware",
    "list_all_specs_worktree_aware",
    "init_auto_claude_dir",
]
