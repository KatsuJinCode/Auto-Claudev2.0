"""
Git Validators
==============

Validators for git operations:
- Commit with secret scanning
- Config protection (prevent setting test users)
"""

import shlex
from pathlib import Path

from .validation_models import ValidationResult

# =============================================================================
# BLOCKED GIT CONFIG PATTERNS
# =============================================================================

# Git config keys that agents must NOT modify
# These are identity settings that should inherit from the user's global config
BLOCKED_GIT_CONFIG_KEYS = {
    "user.name",
    "user.email",
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
}


def validate_git_config(command_string: str) -> ValidationResult:
    """
    Validate git config commands - block identity changes.

    Agents should not set user.name, user.email, etc. as this:
    1. Breaks commit attribution
    2. Can create fake "Test User" identities
    3. Overrides the user's legitimate git identity

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return True, ""  # Can't parse, let other validators handle it

    if len(tokens) < 2 or tokens[0] != "git" or tokens[1] != "config":
        return True, ""  # Not a git config command

    # Check for any blocked config keys in the command
    command_lower = command_string.lower()

    for blocked_key in BLOCKED_GIT_CONFIG_KEYS:
        if blocked_key in command_lower:
            return False, (
                f"BLOCKED: Cannot modify git identity configuration\n\n"
                f"You attempted to set '{blocked_key}' which is not allowed.\n\n"
                f"WHY: Git identity (user.name, user.email) must inherit from the user's "
                f"global git configuration. Setting fake identities like 'Test User' breaks "
                f"commit attribution and causes serious issues.\n\n"
                f"WHAT TO DO: Simply commit without setting any user configuration. "
                f"The repository will use the correct identity automatically."
            )

    return True, ""


def validate_git_command(command_string: str) -> ValidationResult:
    """
    Main git validator that checks all git security rules.

    Currently validates:
    - git config: Block identity changes
    - git commit: Run secret scanning

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse git command"

    if not tokens or tokens[0] != "git":
        return True, ""

    if len(tokens) < 2:
        return True, ""  # Just "git" with no subcommand

    subcommand = tokens[1]

    # Check git config commands
    if subcommand == "config":
        return validate_git_config(command_string)

    # Check git commit commands (secret scanning)
    if subcommand == "commit":
        return validate_git_commit_secrets(command_string)

    return True, ""


def validate_git_commit_secrets(command_string: str) -> ValidationResult:
    """
    Validate git commit commands - run secret scan before allowing commit.

    This provides autonomous feedback to the AI agent if secrets are detected,
    with actionable instructions on how to fix the issue.

    Args:
        command_string: The full git command string

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        tokens = shlex.split(command_string)
    except ValueError:
        return False, "Could not parse git command"

    if not tokens or tokens[0] != "git":
        return True, ""

    # Only intercept 'git commit' commands (not git add, git push, etc.)
    if len(tokens) < 2 or tokens[1] != "commit":
        return True, ""

    # Import the secret scanner
    try:
        from scan_secrets import get_staged_files, mask_secret, scan_files
    except ImportError:
        # Scanner not available, allow commit (don't break the build)
        return True, ""

    # Get staged files and scan them
    staged_files = get_staged_files()
    if not staged_files:
        return True, ""  # No staged files, allow commit

    matches = scan_files(staged_files, Path.cwd())

    if not matches:
        return True, ""  # No secrets found, allow commit

    # Secrets found! Build detailed feedback for the AI agent
    # Group by file for clearer output
    files_with_secrets: dict[str, list] = {}
    for match in matches:
        if match.file_path not in files_with_secrets:
            files_with_secrets[match.file_path] = []
        files_with_secrets[match.file_path].append(match)

    # Build actionable error message
    error_lines = [
        "SECRETS DETECTED - COMMIT BLOCKED",
        "",
        "The following potential secrets were found in staged files:",
        "",
    ]

    for file_path, file_matches in files_with_secrets.items():
        error_lines.append(f"File: {file_path}")
        for match in file_matches:
            masked = mask_secret(match.matched_text, 12)
            error_lines.append(f"  Line {match.line_number}: {match.pattern_name}")
            error_lines.append(f"    Found: {masked}")
        error_lines.append("")

    error_lines.extend(
        [
            "ACTION REQUIRED:",
            "",
            "1. Move secrets to environment variables:",
            "   - Add the secret value to .env (create if needed)",
            "   - Update the code to use os.environ.get('VAR_NAME') or process.env.VAR_NAME",
            "   - Add the variable name (not value) to .env.example",
            "",
            "2. Example fix:",
            "   BEFORE: api_key = 'sk-abc123...'",
            "   AFTER:  api_key = os.environ.get('API_KEY')",
            "",
            "3. If this is a FALSE POSITIVE (test data, example, mock):",
            "   - Add the file pattern to .secretsignore",
            "   - Example: echo 'tests/fixtures/' >> .secretsignore",
            "",
            "After fixing, stage the changes with 'git add .' and retry the commit.",
        ]
    )

    return False, "\n".join(error_lines)


# Backwards compatibility alias - the registry uses this name
# Now delegates to the comprehensive validator
validate_git_commit = validate_git_command
