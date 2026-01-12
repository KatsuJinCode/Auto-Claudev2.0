#!/usr/bin/env python3
"""
Tests for Git Worktree Management
=================================

Tests the worktree.py module functionality including:
- Worktree creation and removal
- Staging worktree management
- Branch operations
- Merge operations
- Change tracking
"""

import subprocess
from pathlib import Path

import pytest

from worktree import WorktreeManager, WorktreeInfo, WorktreeError, STAGING_WORKTREE_NAME


class TestWorktreeManagerInitialization:
    """Tests for WorktreeManager initialization."""

    def test_init_with_valid_git_repo(self, temp_git_repo: Path):
        """Manager initializes correctly with valid git repo."""
        manager = WorktreeManager(temp_git_repo)

        assert manager.project_dir == temp_git_repo
        assert manager.worktrees_dir == temp_git_repo / ".worktrees"
        assert manager.base_branch is not None

    def test_init_prefers_main_over_current_branch(self, temp_git_repo: Path):
        """Manager prefers main/master over current branch when detecting base branch."""
        # Create and switch to a new branch
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo, capture_output=True
        )

        # Even though we're on feature-branch, manager should prefer main
        manager = WorktreeManager(temp_git_repo)
        assert manager.base_branch == "main"

    def test_init_falls_back_to_current_branch(self, temp_git_repo: Path):
        """Manager falls back to current branch when main/master don't exist."""
        # Delete main branch to force fallback
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo, capture_output=True
        )
        subprocess.run(
            ["git", "branch", "-D", "main"],
            cwd=temp_git_repo, capture_output=True
        )

        manager = WorktreeManager(temp_git_repo)
        assert manager.base_branch == "feature-branch"

    def test_init_with_explicit_base_branch(self, temp_git_repo: Path):
        """Manager uses explicitly provided base branch."""
        manager = WorktreeManager(temp_git_repo, base_branch="main")
        assert manager.base_branch == "main"

    def test_setup_creates_worktrees_directory(self, temp_git_repo: Path):
        """Setup creates the .worktrees directory."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        assert manager.worktrees_dir.exists()
        assert manager.worktrees_dir.is_dir()


class TestWorktreeCreation:
    """Tests for creating worktrees."""

    def test_create_worktree(self, temp_git_repo: Path):
        """Can create a new worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        assert info.path.exists()
        assert info.branch == "auto-claude/test-spec"
        assert info.is_active is True
        assert (info.path / "README.md").exists()

    def test_create_worktree_with_spec_name(self, temp_git_repo: Path):
        """Worktree branch is derived from spec name."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("my-feature-spec")

        assert info.branch == "auto-claude/my-feature-spec"

    def test_get_or_create_replaces_existing_worktree(self, temp_git_repo: Path):
        """get_or_create_worktree returns existing worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info1 = manager.create_worktree("test-spec")
        # Create a file in the worktree
        (info1.path / "test-file.txt").write_text("test")

        # get_or_create should return existing
        info2 = manager.get_or_create_worktree("test-spec")

        assert info2.path.exists()
        # The test file should still be there (same worktree)
        assert (info2.path / "test-file.txt").exists()


class TestStagingWorktree:
    """Tests for staging worktree operations (backward compatibility)."""

    def test_get_or_create_staging_creates_new(self, temp_git_repo: Path):
        """Creates staging worktree if it doesn't exist."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.get_or_create_staging("test-spec")

        assert info.path.exists()
        # Staging is now per-spec, worktree is named after spec
        assert info.path.name == "test-spec"
        assert "auto-claude/test-spec" in info.branch

    def test_get_or_create_staging_returns_existing(self, temp_git_repo: Path):
        """Returns existing staging worktree without recreating."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info1 = manager.get_or_create_staging("test-spec")
        # Add a file
        (info1.path / "marker.txt").write_text("marker")

        info2 = manager.get_or_create_staging("test-spec")

        # Should be the same worktree (marker file exists)
        assert (info2.path / "marker.txt").exists()

    def test_staging_exists_false_when_none(self, temp_git_repo: Path):
        """staging_exists returns False when no staging worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        assert manager.staging_exists() is False

    def test_staging_exists_true_when_created(self, temp_git_repo: Path):
        """staging_exists returns True after creating staging."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.get_or_create_staging("test-spec")

        assert manager.staging_exists() is True

    def test_get_staging_path(self, temp_git_repo: Path):
        """get_staging_path returns correct path."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.get_or_create_staging("test-spec")

        path = manager.get_staging_path()

        assert path is not None
        # Staging is now per-spec, path is named after spec
        assert path.name == "test-spec"

    def test_get_staging_info(self, temp_git_repo: Path):
        """get_staging_info returns WorktreeInfo."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.get_or_create_staging("test-spec")

        info = manager.get_staging_info()

        assert info is not None
        assert isinstance(info, WorktreeInfo)
        assert info.branch is not None


class TestWorktreeRemoval:
    """Tests for removing worktrees."""

    def test_remove_worktree(self, temp_git_repo: Path):
        """Can remove a worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        manager.remove_worktree("test-spec")

        assert not info.path.exists()

    def test_remove_staging(self, temp_git_repo: Path):
        """Can remove staging worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        manager.remove_staging()

        assert not info.path.exists()
        assert manager.staging_exists() is False

    def test_remove_with_delete_branch(self, temp_git_repo: Path):
        """Removing worktree can also delete the branch."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")
        branch_name = info.branch

        manager.remove_worktree("test-spec", delete_branch=True)

        # Verify branch is deleted
        result = subprocess.run(
            ["git", "branch", "--list", branch_name],
            cwd=temp_git_repo, capture_output=True, text=True
        )
        assert branch_name not in result.stdout


class TestWorktreeCommitAndMerge:
    """Tests for commit and merge operations."""

    def test_commit_in_staging(self, temp_git_repo: Path):
        """Can commit changes in staging worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Make changes in staging
        (info.path / "new-file.txt").write_text("new content")

        result = manager.commit_in_staging("Test commit")

        assert result is True

        # Verify commit was made
        log_result = subprocess.run(
            ["git", "log", "--oneline", "-1"],
            cwd=info.path, capture_output=True, text=True
        )
        assert "Test commit" in log_result.stdout

    def test_commit_in_staging_nothing_to_commit(self, temp_git_repo: Path):
        """commit_in_staging succeeds when nothing to commit."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.get_or_create_staging("test-spec")

        # No changes made
        result = manager.commit_in_staging("Empty commit")

        assert result is True  # Should succeed (nothing to commit is OK)

    def test_merge_staging_sync(self, temp_git_repo: Path):
        """Can merge staging worktree to main branch."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Make changes in staging
        (info.path / "feature.txt").write_text("feature content")
        manager.commit_in_staging("Add feature")

        # Merge back
        result = manager.merge_staging(delete_after=False)

        assert result is True

        # Verify file is in main branch
        subprocess.run(["git", "checkout", manager.base_branch], cwd=temp_git_repo, capture_output=True)
        assert (temp_git_repo / "feature.txt").exists()

    def test_merge_worktree(self, temp_git_repo: Path):
        """Can merge a worktree back to main."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a worktree with changes
        worker_info = manager.create_worktree("worker-spec")
        (worker_info.path / "worker-file.txt").write_text("worker content")
        subprocess.run(["git", "add", "."], cwd=worker_info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Worker commit"],
            cwd=worker_info.path, capture_output=True
        )

        # Merge worktree back to main
        result = manager.merge_worktree("worker-spec", delete_after=False)

        assert result is True

        # Verify file is in main branch
        subprocess.run(["git", "checkout", manager.base_branch], cwd=temp_git_repo, capture_output=True)
        assert (temp_git_repo / "worker-file.txt").exists()


class TestChangeTracking:
    """Tests for tracking changes in worktrees."""

    def test_has_uncommitted_changes_false(self, temp_git_repo: Path):
        """has_uncommitted_changes returns False when clean."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        assert manager.has_uncommitted_changes() is False

    def test_has_uncommitted_changes_true(self, temp_git_repo: Path):
        """has_uncommitted_changes returns True when dirty."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Make uncommitted changes
        (temp_git_repo / "dirty.txt").write_text("uncommitted")

        assert manager.has_uncommitted_changes() is True

    def test_get_change_summary(self, temp_git_repo: Path):
        """get_change_summary returns correct counts."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Make various changes
        (info.path / "new-file.txt").write_text("new")
        (info.path / "README.md").write_text("modified")
        manager.commit_in_staging("Changes")

        summary = manager.get_change_summary("test-spec")

        assert summary["new_files"] == 1  # new-file.txt
        assert summary["modified_files"] == 1  # README.md

    def test_get_changed_files(self, temp_git_repo: Path):
        """get_changed_files returns list of changed files."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Make changes
        (info.path / "added.txt").write_text("new file")
        manager.commit_in_staging("Add file")

        files = manager.get_changed_files("test-spec")

        assert len(files) > 0
        file_names = [f[1] for f in files]
        assert "added.txt" in file_names


class TestWorktreeUtilities:
    """Tests for utility methods."""

    def test_list_worktrees(self, temp_git_repo: Path):
        """list_all_worktrees returns active worktrees."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("spec-1")
        manager.create_worktree("spec-2")

        worktrees = manager.list_all_worktrees()

        assert len(worktrees) == 2

    def test_get_info(self, temp_git_repo: Path):
        """get_worktree_info returns correct WorktreeInfo."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("test-spec")

        info = manager.get_worktree_info("test-spec")

        assert info is not None
        assert info.branch == "auto-claude/test-spec"

    def test_get_worktree_path(self, temp_git_repo: Path):
        """get_worktree_path returns correct path."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("test-spec")

        path = manager.get_worktree_path("test-spec")

        assert path == info.path

    def test_cleanup_all(self, temp_git_repo: Path):
        """cleanup_all removes all worktrees."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        manager.create_worktree("spec-1")
        manager.create_worktree("spec-2")
        manager.get_or_create_staging("test-spec")

        manager.cleanup_all()

        assert len(manager.list_all_worktrees()) == 0

    def test_cleanup_stale_worktrees(self, temp_git_repo: Path):
        """cleanup_stale_worktrees removes directories without git tracking."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Create a stale worktree directory (exists but not tracked by git)
        stale_dir = manager.worktrees_dir / "stale-worktree"
        stale_dir.mkdir(parents=True, exist_ok=True)

        # This should clean up the stale directory
        manager.cleanup_stale_worktrees()

        # Stale directory should be removed
        assert not stale_dir.exists()

    def test_get_test_commands_python(self, temp_git_repo: Path):
        """get_test_commands detects Python project commands."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Create requirements.txt
        (info.path / "requirements.txt").write_text("flask\n")

        commands = manager.get_test_commands("test-spec")

        assert any("pip" in cmd for cmd in commands)

    def test_get_test_commands_node(self, temp_git_repo: Path):
        """get_test_commands detects Node.js project commands."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.get_or_create_staging("test-spec")

        # Create package.json
        (info.path / "package.json").write_text('{"name": "test"}')

        commands = manager.get_test_commands("test-spec")

        assert any("npm" in cmd for cmd in commands)


class TestWorktreeSafetyCheck:
    """Tests for worktree safety check functionality.
    
    ✓ DETERMINATE: All tests exit when assertion completes or fails.
    
    The safety check prevents catastrophic data loss by blocking
    worktree creation when:
    - Non-main/master branches exist (user might be working on them)
    - Existing worktrees exist (could cause confusion)
    """

    def test_safety_check_safe_when_only_main(self, temp_git_repo: Path):
        """Safety check passes when only main branch exists.
        
        ✓ DETERMINATE: test_safety_check_safe_when_only_main exits when assertions complete.
        """
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        safety = manager.check_worktree_safety()
        
        assert safety.is_safe is True
        assert safety.current_branch == "main"
        assert len(safety.other_branches) == 0
        assert len(safety.existing_worktrees) == 0
        assert safety.warning_message is None

    def test_safety_check_unsafe_with_other_branch(self, temp_git_repo: Path):
        """Safety check fails when non-main branches exist.
        
        ✓ DETERMINATE: test_safety_check_unsafe_with_other_branch exits when assertions complete.
        """
        # Create another branch
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo, capture_output=True
        )
        subprocess.run(
            ["git", "checkout", "main"],
            cwd=temp_git_repo, capture_output=True
        )
        
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        safety = manager.check_worktree_safety()
        
        assert safety.is_safe is False
        assert "feature-branch" in safety.other_branches
        assert safety.warning_message is not None
        assert "DANGER" in safety.warning_message

    def test_safety_check_unsafe_with_existing_worktree(self, temp_git_repo: Path):
        """Safety check fails when worktrees already exist.
        
        ✓ DETERMINATE: test_safety_check_unsafe_with_existing_worktree exits when assertions complete.
        """
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        # Create a worktree first (with force to bypass safety for setup)
        manager.create_worktree("existing-spec", force_unsafe=True)
        
        # Now check safety for creating another
        safety = manager.check_worktree_safety()
        
        assert safety.is_safe is False
        assert len(safety.existing_worktrees) > 0
        assert safety.warning_message is not None

    def test_safety_check_ignores_auto_claude_branches(self, temp_git_repo: Path):
        """Safety check ignores auto-claude/* branches (they're ours).
        
        ✓ DETERMINATE: test_safety_check_ignores_auto_claude_branches exits when assertions complete.
        """
        # Create an auto-claude branch
        subprocess.run(
            ["git", "checkout", "-b", "auto-claude/test-spec"],
            cwd=temp_git_repo, capture_output=True
        )
        subprocess.run(
            ["git", "checkout", "main"],
            cwd=temp_git_repo, capture_output=True
        )
        
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        safety = manager.check_worktree_safety()
        
        # auto-claude branches should not trigger unsafe
        assert "auto-claude/test-spec" not in safety.other_branches
        assert safety.is_safe is True

    def test_create_worktree_blocked_when_unsafe(self, temp_git_repo: Path):
        """create_worktree raises error when safety check fails.
        
        ✓ DETERMINATE: test_create_worktree_blocked_when_unsafe exits when exception caught or assertion fails.
        """
        # Create another branch to make it unsafe
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo, capture_output=True
        )
        subprocess.run(
            ["git", "checkout", "main"],
            cwd=temp_git_repo, capture_output=True
        )
        
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        with pytest.raises(WorktreeError) as exc_info:
            manager.create_worktree("new-spec")
        
        assert "BLOCKED" in str(exc_info.value)
        assert "unsafe" in str(exc_info.value).lower()

    def test_create_worktree_force_unsafe_bypasses_check(self, temp_git_repo: Path):
        """create_worktree with force_unsafe=True bypasses safety check.
        
        ✓ DETERMINATE: test_create_worktree_force_unsafe_bypasses_check exits when assertions complete.
        """
        # Create another branch to make it unsafe
        subprocess.run(
            ["git", "checkout", "-b", "feature-branch"],
            cwd=temp_git_repo, capture_output=True
        )
        subprocess.run(
            ["git", "checkout", "main"],
            cwd=temp_git_repo, capture_output=True
        )
        
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        # Should succeed with force_unsafe=True
        info = manager.create_worktree("new-spec", force_unsafe=True)
        
        assert info.path.exists()
        assert info.branch == "auto-claude/new-spec"

    def test_safety_check_warning_mentions_current_branch(self, temp_git_repo: Path):
        """Warning message mentions current branch when not on main.
        
        ✓ DETERMINATE: test_safety_check_warning_mentions_current_branch exits when assertions complete.
        """
        # Create and stay on feature branch
        subprocess.run(
            ["git", "checkout", "-b", "my-feature"],
            cwd=temp_git_repo, capture_output=True
        )
        
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        safety = manager.check_worktree_safety()
        
        assert safety.current_branch == "my-feature"
        assert safety.is_safe is False
        assert "my-feature" in safety.warning_message
        assert "WARNING" in safety.warning_message

    def test_safety_check_dataclass_to_dict(self, temp_git_repo: Path):
        """WorktreeSafetyCheck.to_dict() returns correct dictionary.
        
        ✓ DETERMINATE: test_safety_check_dataclass_to_dict exits when assertions complete.
        """
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        
        safety = manager.check_worktree_safety()
        d = safety.to_dict()
        
        assert "is_safe" in d
        assert "current_branch" in d
        assert "base_branch" in d
        assert "other_branches" in d
        assert "existing_worktrees" in d
        assert d["is_safe"] == safety.is_safe
