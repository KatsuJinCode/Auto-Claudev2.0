"""
Auto-Claude Configuration Module
================================

Defines the configuration schema for .auto-claude project configuration.
The config file is stored at `.auto-claude/config.json` in the project directory.

This module provides:
- AutoClaudeConfig dataclass for project-level configuration
- Functions to load/save configuration from/to .auto-claude/config.json
- Integration with phase_config.py agent provider definitions

Configuration File:
    .auto-claude/config.json - Project-level Auto-Claude settings

Example config.json:
    {
        "default_agent": "claude",
        "default_model": null
    }
"""

import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path

from phase_config import (
    get_available_agents,
    get_default_agent,
    get_default_model_for_agent,
    is_valid_agent,
)

# Configuration file name within .auto-claude directory
CONFIG_FILE_NAME = "config.json"

logger = logging.getLogger(__name__)


@dataclass
class AutoClaudeConfig:
    """
    Configuration for Auto-Claude project settings.

    This configuration is stored in .auto-claude/config.json and contains
    project-level settings that persist across sessions.

    Attributes:
        default_agent: Default AI agent provider to use (claude, gemini, opencode).
                      Falls back to 'claude' if not specified or invalid.
        default_model: Default model for the agent. If None, uses the agent's
                      default model from phase_config.py.
    """

    default_agent: str = "claude"
    default_model: str | None = None

    def __post_init__(self) -> None:
        """Validate and normalize configuration values after initialization."""
        # Normalize and validate default_agent
        if not self.default_agent:
            self.default_agent = get_default_agent()
        else:
            self.default_agent = self.default_agent.lower().strip()
            if not is_valid_agent(self.default_agent):
                logger.warning(
                    f"Invalid default_agent '{self.default_agent}'. "
                    f"Valid options: {get_available_agents()}. "
                    f"Falling back to '{get_default_agent()}'."
                )
                self.default_agent = get_default_agent()

    def get_resolved_model(self) -> str:
        """
        Get the resolved model for the default agent.

        If default_model is set, returns it. Otherwise returns the
        default model for the configured agent.

        Returns:
            Model identifier string
        """
        if self.default_model:
            return self.default_model
        return get_default_model_for_agent(self.default_agent)

    def to_dict(self) -> dict:
        """
        Convert config to dictionary for JSON serialization.

        Returns:
            Dictionary representation of the config
        """
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "AutoClaudeConfig":
        """
        Create config from dictionary.

        Args:
            data: Dictionary with config values

        Returns:
            AutoClaudeConfig instance
        """
        return cls(
            default_agent=data.get("default_agent", "claude"),
            default_model=data.get("default_model"),
        )

    def is_valid(self) -> bool:
        """
        Check if configuration is valid.

        Returns:
            True if configuration is valid
        """
        return is_valid_agent(self.default_agent)

    def get_validation_errors(self) -> list[str]:
        """
        Get list of validation errors for current configuration.

        Returns:
            List of error messages (empty if valid)
        """
        errors = []

        if not is_valid_agent(self.default_agent):
            available = get_available_agents()
            errors.append(
                f"Invalid default_agent '{self.default_agent}'. "
                f"Valid options: {available}"
            )

        return errors


def get_config_path(project_dir: Path) -> Path:
    """
    Get the path to the config file.

    Args:
        project_dir: Project root directory

    Returns:
        Path to .auto-claude/config.json
    """
    return Path(project_dir) / ".auto-claude" / CONFIG_FILE_NAME


def load_config(project_dir: Path) -> AutoClaudeConfig:
    """
    Load configuration from .auto-claude/config.json.

    If the config file doesn't exist or is invalid, returns default config.

    Args:
        project_dir: Project root directory

    Returns:
        AutoClaudeConfig instance
    """
    config_path = get_config_path(project_dir)

    if not config_path.exists():
        logger.debug(f"Config file not found at {config_path}, using defaults")
        return AutoClaudeConfig()

    try:
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)

        config = AutoClaudeConfig.from_dict(data)
        logger.debug(f"Loaded config from {config_path}: {config}")
        return config

    except json.JSONDecodeError as e:
        logger.warning(f"Invalid JSON in config file {config_path}: {e}")
        return AutoClaudeConfig()

    except OSError as e:
        logger.warning(f"Error reading config file {config_path}: {e}")
        return AutoClaudeConfig()


def save_config(project_dir: Path, config: AutoClaudeConfig) -> bool:
    """
    Save configuration to .auto-claude/config.json.

    Creates the .auto-claude directory if it doesn't exist.

    Args:
        project_dir: Project root directory
        config: Configuration to save

    Returns:
        True if save was successful, False otherwise
    """
    config_path = get_config_path(project_dir)

    try:
        # Ensure .auto-claude directory exists
        config_path.parent.mkdir(parents=True, exist_ok=True)

        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config.to_dict(), f, indent=2)
            f.write("\n")  # Add trailing newline

        logger.debug(f"Saved config to {config_path}")
        return True

    except OSError as e:
        logger.error(f"Error saving config to {config_path}: {e}")
        return False


def get_project_agent(project_dir: Path, cli_agent: str | None = None) -> str:
    """
    Get the agent to use for a project.

    Priority:
    1. CLI argument (if provided)
    2. Project config default_agent
    3. Global default (claude)

    Args:
        project_dir: Project root directory
        cli_agent: Agent from CLI argument (optional)

    Returns:
        Agent provider name (claude, gemini, opencode)
    """
    # CLI argument takes precedence
    if cli_agent:
        agent = cli_agent.lower().strip()
        if is_valid_agent(agent):
            return agent
        logger.warning(
            f"Invalid CLI agent '{cli_agent}'. "
            f"Valid options: {get_available_agents()}. "
            f"Falling back to project default."
        )

    # Load project config
    config = load_config(project_dir)
    return config.default_agent


def get_project_model(
    project_dir: Path,
    cli_model: str | None = None,
    cli_agent: str | None = None,
) -> str:
    """
    Get the model to use for a project.

    Priority:
    1. CLI model argument (if provided)
    2. Project config default_model (if set)
    3. Default model for the agent

    Args:
        project_dir: Project root directory
        cli_model: Model from CLI argument (optional)
        cli_agent: Agent from CLI argument (optional, used to determine default)

    Returns:
        Model identifier string
    """
    # CLI model takes precedence
    if cli_model:
        return cli_model

    # Load project config
    config = load_config(project_dir)

    # Use config model if set
    if config.default_model:
        return config.default_model

    # Get the agent (CLI or config)
    agent = get_project_agent(project_dir, cli_agent)

    # Return default model for the agent
    return get_default_model_for_agent(agent)


def ensure_config_exists(project_dir: Path) -> AutoClaudeConfig:
    """
    Ensure config file exists, creating it with defaults if necessary.

    Args:
        project_dir: Project root directory

    Returns:
        AutoClaudeConfig instance
    """
    config_path = get_config_path(project_dir)

    if config_path.exists():
        return load_config(project_dir)

    # Create default config
    config = AutoClaudeConfig()
    save_config(project_dir, config)
    return config


def update_config(
    project_dir: Path,
    default_agent: str | None = None,
    default_model: str | None = None,
) -> AutoClaudeConfig:
    """
    Update specific fields in the project configuration.

    Loads existing config, updates specified fields, and saves.

    Args:
        project_dir: Project root directory
        default_agent: New default agent (optional)
        default_model: New default model (optional)

    Returns:
        Updated AutoClaudeConfig instance
    """
    config = load_config(project_dir)

    if default_agent is not None:
        config.default_agent = default_agent.lower().strip()
        # Re-run validation
        config.__post_init__()

    if default_model is not None:
        config.default_model = default_model if default_model else None

    save_config(project_dir, config)
    return config
