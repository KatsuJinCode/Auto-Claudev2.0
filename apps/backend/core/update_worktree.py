#!/usr/bin/env python3
"""Script to add worktree safety checks."""
import re

with open('worktree.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add new dataclass after WorktreeInfo
new_dataclass = '''

@dataclass
class WorktreeSafetyCheck:
    """Result of worktree safety check."""

    is_safe: bool
    current_branch: str
    base_branch: str
    other_branches: list[str]  # Branches other than main/master
    existing_worktrees: list[str]  # Existing worktree names
    warning_message: str | None = None

    def to_dict(self) -> dict:
        """Convert to dictionary for IPC."""
        return {
            "is_safe": self.is_safe,
            "current_branch": self.current_branch,
            "base_branch": self.base_branch,
            "other_branches": self.other_branches,
            "existing_worktrees": self.existing_worktrees,
            "warning_message": self.warning_message,
        }

'''

# Find the end of WorktreeInfo dataclass and insert after it
worktree_info_end = content.find('class WorktreeManager:')
if worktree_info_end != -1:
    content = content[:worktree_info_end] + new_dataclass + content[worktree_info_end:]
    print("Added WorktreeSafetyCheck dataclass")
else:
    print("ERROR: Could not find WorktreeManager class")
    exit(1)

# 2. Add the safety check method after _get_current_branch
safety_method = '''

    def _get_all_branches(self) -> list[str]:
        """Get all local branch names."""
        result = self._run_git(["branch", "--format=%(refname:short)"])
        if result.returncode != 0:
            return []
        return [b.strip() for b in result.stdout.strip().split("\\n") if b.strip()]

    def _get_existing_worktrees(self) -> list[str]:
        """Get list of existing git worktrees (excluding main)."""
        result = self._run_git(["worktree", "list", "--porcelain"])
        if result.returncode != 0:
            return []

        worktrees = []
        for line in result.stdout.split("\\n"):
            if line.startswith("worktree "):
                path = line.split(" ", 1)[1]
                # Skip the main worktree (project dir)
                if path != str(self.project_dir):
                    worktrees.append(path)
        return worktrees

    def check_worktree_safety(self) -> WorktreeSafetyCheck:
        """
        Check if it is safe to create a worktree.

        BLOCKS worktree creation if:
        - Any branch exists besides main/master (user might be working on it)
        - Any existing worktrees exist (could cause confusion)

        This prevents the catastrophic scenario where:
        1. User is working on branch 'feature-x'
        2. Auto-Claude creates worktree from 'main' (not 'feature-x')
        3. Work is done in worktree
        4. Merge back to 'main' - but 'feature-x' work is lost!

        Returns:
            WorktreeSafetyCheck with safety status and details
        """
        current_branch = self._get_current_branch()
        all_branches = self._get_all_branches()
        existing_worktrees = self._get_existing_worktrees()

        # Identify "safe" base branches
        safe_bases = {"main", "master"}

        # Find branches that are NOT main/master and NOT auto-claude branches
        other_branches = [
            b for b in all_branches
            if b not in safe_bases
            and not b.startswith("auto-claude/")
        ]

        # Determine if safe
        is_safe = len(other_branches) == 0 and len(existing_worktrees) == 0

        # Build warning message if unsafe
        warning_message = None
        if not is_safe:
            warnings = []

            if other_branches:
                branch_list = ", ".join(other_branches[:5])
                if len(other_branches) > 5:
                    branch_list += f"... and {len(other_branches) - 5} more"
                warnings.append(
                    f"DANGER: {len(other_branches)} branch(es) exist besides main/master:\\n"
                    f"  {branch_list}"
                )
                warnings.append(
                    f"\\nYou are currently on branch '{current_branch}'."
                )
                if current_branch not in safe_bases:
                    warnings.append(
                        f"\\nWARNING: Creating a worktree from '{self.base_branch}' will NOT include "
                        f"work from '{current_branch}'!\\n"
                        f"Any work done in the worktree and merged back will NOT contain "
                        f"your current branch's changes."
                    )

            if existing_worktrees:
                wt_list = "\\n  ".join(existing_worktrees)
                warnings.append(
                    f"\\nExisting worktrees found:\\n  {wt_list}"
                )

            warning_message = "\\n".join(warnings)

        return WorktreeSafetyCheck(
            is_safe=is_safe,
            current_branch=current_branch,
            base_branch=self.base_branch,
            other_branches=other_branches,
            existing_worktrees=existing_worktrees,
            warning_message=warning_message,
        )
'''

# Find where to insert the safety method (after _run_git method)
run_git_match = re.search(r'def _run_git\(.*?\n        return subprocess\.run\(.*?\n        \)', content, re.DOTALL)
if run_git_match:
    insert_pos = run_git_match.end()
    content = content[:insert_pos] + safety_method + content[insert_pos:]
    print("Added safety check methods")
else:
    print("ERROR: Could not find _run_git method")
    exit(1)

# 3. Modify create_worktree to add safety check
old_create_worktree_doc = '''    def create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Create a worktree for a spec.

        Args:
            spec_name: The spec folder name (e.g., "002-implement-memory")

        Returns:
            WorktreeInfo for the created worktree

        Raises:
            WorktreeError: If a branch namespace conflict exists or worktree creation fails
        """
        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        # Check for branch namespace conflict'''

new_create_worktree_doc = '''    def create_worktree(
        self, spec_name: str, force_unsafe: bool = False
    ) -> WorktreeInfo:
        """
        Create a worktree for a spec.

        Args:
            spec_name: The spec folder name (e.g., "002-implement-memory")
            force_unsafe: If True, bypass safety checks (DANGEROUS - requires user acknowledgment)

        Returns:
            WorktreeInfo for the created worktree

        Raises:
            WorktreeError: If safety check fails, branch namespace conflict exists,
                          or worktree creation fails
        """
        # CRITICAL SAFETY CHECK: Prevent data loss from wrong base branch
        if not force_unsafe:
            safety = self.check_worktree_safety()
            if not safety.is_safe:
                raise WorktreeError(
                    f"BLOCKED: Cannot create worktree - unsafe git state detected.\\n\\n"
                    f"{safety.warning_message}\\n\\n"
                    f"To proceed anyway, you must explicitly acknowledge this risk.\\n"
                    f"This check exists because creating worktrees from the wrong branch "
                    f"has caused catastrophic data loss in the past."
                )

        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        # Check for branch namespace conflict'''

if old_create_worktree_doc in content:
    content = content.replace(old_create_worktree_doc, new_create_worktree_doc)
    print("Modified create_worktree with safety check")
else:
    print("ERROR: Could not find create_worktree method signature")
    exit(1)

# 4. Also update get_or_create_worktree to pass through force_unsafe
old_get_or_create = '''    def get_or_create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Get existing worktree or create a new one for a spec.

        Args:
            spec_name: The spec folder name

        Returns:
            WorktreeInfo for the worktree
        """
        existing = self.get_worktree_info(spec_name)
        if existing:
            print(f"Using existing worktree: {existing.path}")
            return existing

        return self.create_worktree(spec_name)'''

new_get_or_create = '''    def get_or_create_worktree(
        self, spec_name: str, force_unsafe: bool = False
    ) -> WorktreeSafetyCheck | WorktreeInfo:
        """
        Get existing worktree or create a new one for a spec.

        Args:
            spec_name: The spec folder name
            force_unsafe: If True, bypass safety checks when creating (DANGEROUS)

        Returns:
            WorktreeInfo for the worktree, or WorktreeSafetyCheck if blocked
        """
        existing = self.get_worktree_info(spec_name)
        if existing:
            print(f"Using existing worktree: {existing.path}")
            return existing

        # Check safety before creating
        if not force_unsafe:
            safety = self.check_worktree_safety()
            if not safety.is_safe:
                return safety  # Return safety check so caller can show UI

        return self.create_worktree(spec_name, force_unsafe=force_unsafe)'''

if old_get_or_create in content:
    content = content.replace(old_get_or_create, new_get_or_create)
    print("Modified get_or_create_worktree")
else:
    print("WARNING: Could not find get_or_create_worktree - may have different formatting")

with open('worktree.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("\nSUCCESS: worktree.py updated with safety checks")
