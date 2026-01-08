"""
Phase Configuration Module
===========================

Handles model and thinking level configuration for different execution phases.
Reads configuration from task_metadata.json and provides resolved model IDs.

Also provides agent provider configuration for multi-agent support, allowing
users to choose between different AI backends (Claude, Gemini, OpenCode).
"""

import json
from enum import Enum
from pathlib import Path
from typing import Literal, TypedDict

# Model shorthand to full model ID mapping
MODEL_ID_MAP: dict[str, str] = {
    "opus": "claude-opus-4-5-20251101",
    "sonnet": "claude-sonnet-4-5-20250929",
    "haiku": "claude-haiku-4-5-20251001",
}


# =============================================================================
# Agent Provider Configuration (Multi-Agent Support)
# =============================================================================


class AgentProvider(str, Enum):
    """
    Supported AI agent backend providers.

    Each provider has a different CLI interface and capabilities:
    - CLAUDE: Uses Claude Agent SDK (native integration)
    - GEMINI: Uses Gemini CLI with --resume, --model flags
    - OPENCODE: Uses OpenCode CLI with --session, --model flags
    """

    CLAUDE = "claude"
    GEMINI = "gemini"
    OPENCODE = "opencode"


# Type alias for string literals
AgentProviderLiteral = Literal["claude", "gemini", "opencode"]


# Default models for each agent provider
# These are used when no model is explicitly specified
DEFAULT_AGENT_MODELS: dict[str, str] = {
    "claude": "claude-sonnet-4-5-20250929",
    "gemini": "gemini-2.5-pro",
    "opencode": "anthropic/claude-sonnet-4-20250514",
}


# Full model map for each agent provider
# Maps provider to available models with their display names and identifiers
AGENT_MODEL_MAP: dict[str, dict[str, str]] = {
    "claude": {
        # Claude models (Anthropic)
        "opus": "claude-opus-4-5-20251101",
        "sonnet": "claude-sonnet-4-5-20250929",
        "haiku": "claude-haiku-4-5-20251001",
        # Full model IDs also supported
        "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
        "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
    },
    "gemini": {
        # Gemini models (Google)
        "gemini-2.5-pro": "gemini-2.5-pro",
        "gemini-2.5-flash": "gemini-2.5-flash",
        "gemini-2.0-flash": "gemini-2.0-flash",
        "gemini-1.5-pro": "gemini-1.5-pro",
        "gemini-1.5-flash": "gemini-1.5-flash",
    },
    "opencode": {
        # OpenCode models (provider/model format)
        # Anthropic via OpenCode
        "anthropic/claude-sonnet-4-20250514": "anthropic/claude-sonnet-4-20250514",
        "anthropic/claude-opus-4-20250514": "anthropic/claude-opus-4-20250514",
        # OpenAI via OpenCode
        "openai/gpt-4o": "openai/gpt-4o",
        "openai/gpt-4-turbo": "openai/gpt-4-turbo",
        "openai/o1": "openai/o1",
        # Google via OpenCode
        "google/gemini-2.5-pro": "google/gemini-2.5-pro",
        "google/gemini-2.5-flash": "google/gemini-2.5-flash",
    },
}


# CLI command patterns for each agent provider
# Useful for validation and display
AGENT_CLI_COMMANDS: dict[str, str] = {
    "claude": "claude",
    "gemini": "gemini",
    "opencode": "opencode run",
}


# Environment variables for system prompts (per agent)
AGENT_SYSTEM_PROMPT_ENV: dict[str, str | None] = {
    "claude": None,  # Claude uses --system-prompt flag via SDK
    "gemini": "GEMINI_SYSTEM_PROMPT",
    "opencode": "OPENCODE_SYSTEM_PROMPT",
}


def get_default_agent() -> str:
    """Get the default agent provider."""
    return AgentProvider.CLAUDE.value


def get_default_model_for_agent(agent: str) -> str:
    """
    Get the default model for a given agent provider.

    Args:
        agent: Agent provider name (claude, gemini, opencode)

    Returns:
        Default model identifier for the agent
    """
    agent_lower = agent.lower()
    return DEFAULT_AGENT_MODELS.get(agent_lower, DEFAULT_AGENT_MODELS["claude"])


def resolve_agent_model(agent: str, model: str | None) -> str:
    """
    Resolve a model identifier for a given agent provider.

    If model is None, returns the default model for the agent.
    If model is a shorthand (e.g., "opus" for Claude), resolves to full ID.
    Otherwise returns the model as-is.

    Args:
        agent: Agent provider name (claude, gemini, opencode)
        model: Model identifier or shorthand, or None for default

    Returns:
        Resolved model identifier
    """
    agent_lower = agent.lower()

    # Return default if no model specified
    if model is None:
        return get_default_model_for_agent(agent_lower)

    # Try to resolve from agent's model map
    agent_models = AGENT_MODEL_MAP.get(agent_lower, {})
    if model in agent_models:
        return agent_models[model]

    # Return model as-is (user may be using a custom/new model)
    return model


def is_valid_agent(agent: str) -> bool:
    """
    Check if an agent provider name is valid.

    Args:
        agent: Agent provider name to validate

    Returns:
        True if valid, False otherwise
    """
    try:
        AgentProvider(agent.lower())
        return True
    except ValueError:
        return False


def get_available_agents() -> list[str]:
    """
    Get list of available agent provider names.

    Returns:
        List of agent provider names
    """
    return [p.value for p in AgentProvider]


def get_agent_cli_command(agent: str) -> str | None:
    """
    Get the CLI command for an agent provider.

    Args:
        agent: Agent provider name

    Returns:
        CLI command string or None if unknown
    """
    return AGENT_CLI_COMMANDS.get(agent.lower())


# =============================================================================
# Phase Configuration (Thinking Levels & Model Selection)
# =============================================================================

# Thinking level to budget tokens mapping (None = no extended thinking)
# Values must match auto-claude-ui/src/shared/constants/models.ts THINKING_BUDGET_MAP
THINKING_BUDGET_MAP: dict[str, int | None] = {
    "none": None,
    "low": 1024,
    "medium": 4096,  # Moderate analysis
    "high": 16384,  # Deep thinking for QA review
    "ultrathink": 65536,  # Maximum reasoning depth
}

# Spec runner phase-specific thinking levels
# Heavy phases use ultrathink for deep analysis
# Light phases use medium after compaction
SPEC_PHASE_THINKING_LEVELS: dict[str, str] = {
    # Heavy phases - ultrathink (discovery, spec creation, self-critique)
    "discovery": "ultrathink",
    "spec_writing": "ultrathink",
    "self_critique": "ultrathink",
    # Light phases - medium (after first invocation with compaction)
    "requirements": "medium",
    "research": "medium",
    "context": "medium",
    "planning": "medium",
    "validation": "medium",
    "quick_spec": "medium",
    "historical_context": "medium",
    "complexity_assessment": "medium",
}

# Default phase configuration (matches UI defaults)
DEFAULT_PHASE_MODELS: dict[str, str] = {
    "spec": "sonnet",
    "planning": "opus",
    "coding": "sonnet",
    "qa": "sonnet",
}

DEFAULT_PHASE_THINKING: dict[str, str] = {
    "spec": "medium",
    "planning": "high",
    "coding": "medium",
    "qa": "high",
}


class PhaseModelConfig(TypedDict, total=False):
    spec: str
    planning: str
    coding: str
    qa: str


class PhaseThinkingConfig(TypedDict, total=False):
    spec: str
    planning: str
    coding: str
    qa: str


class TaskMetadataConfig(TypedDict, total=False):
    """Structure of model-related fields in task_metadata.json"""

    isAutoProfile: bool
    phaseModels: PhaseModelConfig
    phaseThinking: PhaseThinkingConfig
    model: str
    thinkingLevel: str


Phase = Literal["spec", "planning", "coding", "qa"]


def resolve_model_id(model: str) -> str:
    """
    Resolve a model shorthand (haiku, sonnet, opus) to a full model ID.
    If the model is already a full ID, return it unchanged.

    Args:
        model: Model shorthand or full ID

    Returns:
        Full Claude model ID
    """
    # Check if it's a shorthand
    if model in MODEL_ID_MAP:
        return MODEL_ID_MAP[model]

    # Already a full model ID
    return model


def get_thinking_budget(thinking_level: str) -> int | None:
    """
    Get the thinking budget for a thinking level.

    Args:
        thinking_level: Thinking level (none, low, medium, high, ultrathink)

    Returns:
        Token budget or None for no extended thinking
    """
    import logging

    if thinking_level not in THINKING_BUDGET_MAP:
        valid_levels = ", ".join(THINKING_BUDGET_MAP.keys())
        logging.warning(
            f"Invalid thinking_level '{thinking_level}'. Valid values: {valid_levels}. "
            f"Defaulting to 'medium'."
        )
        return THINKING_BUDGET_MAP["medium"]

    return THINKING_BUDGET_MAP[thinking_level]


def load_task_metadata(spec_dir: Path) -> TaskMetadataConfig | None:
    """
    Load task_metadata.json from the spec directory.

    Args:
        spec_dir: Path to the spec directory

    Returns:
        Parsed task metadata or None if not found
    """
    metadata_path = spec_dir / "task_metadata.json"
    if not metadata_path.exists():
        return None

    try:
        with open(metadata_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def get_phase_model(
    spec_dir: Path,
    phase: Phase,
    cli_model: str | None = None,
) -> str:
    """
    Get the resolved model ID for a specific execution phase.

    Priority:
    1. CLI argument (if provided)
    2. Phase-specific config from task_metadata.json (if auto profile)
    3. Single model from task_metadata.json (if not auto profile)
    4. Default phase configuration

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_model: Model from CLI argument (optional)

    Returns:
        Resolved full model ID
    """
    # CLI argument takes precedence
    if cli_model:
        return resolve_model_id(cli_model)

    # Load task metadata
    metadata = load_task_metadata(spec_dir)

    if metadata:
        # Check for auto profile with phase-specific config
        if metadata.get("isAutoProfile") and metadata.get("phaseModels"):
            phase_models = metadata["phaseModels"]
            model = phase_models.get(phase, DEFAULT_PHASE_MODELS[phase])
            return resolve_model_id(model)

        # Non-auto profile: use single model
        if metadata.get("model"):
            return resolve_model_id(metadata["model"])

    # Fall back to default phase configuration
    return resolve_model_id(DEFAULT_PHASE_MODELS[phase])


def get_phase_thinking(
    spec_dir: Path,
    phase: Phase,
    cli_thinking: str | None = None,
) -> str:
    """
    Get the thinking level for a specific execution phase.

    Priority:
    1. CLI argument (if provided)
    2. Phase-specific config from task_metadata.json (if auto profile)
    3. Single thinking level from task_metadata.json (if not auto profile)
    4. Default phase configuration

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_thinking: Thinking level from CLI argument (optional)

    Returns:
        Thinking level string
    """
    # CLI argument takes precedence
    if cli_thinking:
        return cli_thinking

    # Load task metadata
    metadata = load_task_metadata(spec_dir)

    if metadata:
        # Check for auto profile with phase-specific config
        if metadata.get("isAutoProfile") and metadata.get("phaseThinking"):
            phase_thinking = metadata["phaseThinking"]
            return phase_thinking.get(phase, DEFAULT_PHASE_THINKING[phase])

        # Non-auto profile: use single thinking level
        if metadata.get("thinkingLevel"):
            return metadata["thinkingLevel"]

    # Fall back to default phase configuration
    return DEFAULT_PHASE_THINKING[phase]


def get_phase_thinking_budget(
    spec_dir: Path,
    phase: Phase,
    cli_thinking: str | None = None,
) -> int | None:
    """
    Get the thinking budget tokens for a specific execution phase.

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_thinking: Thinking level from CLI argument (optional)

    Returns:
        Token budget or None for no extended thinking
    """
    thinking_level = get_phase_thinking(spec_dir, phase, cli_thinking)
    return get_thinking_budget(thinking_level)


def get_phase_config(
    spec_dir: Path,
    phase: Phase,
    cli_model: str | None = None,
    cli_thinking: str | None = None,
) -> tuple[str, str, int | None]:
    """
    Get the full configuration for a specific execution phase.

    Args:
        spec_dir: Path to the spec directory
        phase: Execution phase (spec, planning, coding, qa)
        cli_model: Model from CLI argument (optional)
        cli_thinking: Thinking level from CLI argument (optional)

    Returns:
        Tuple of (model_id, thinking_level, thinking_budget)
    """
    model_id = get_phase_model(spec_dir, phase, cli_model)
    thinking_level = get_phase_thinking(spec_dir, phase, cli_thinking)
    thinking_budget = get_thinking_budget(thinking_level)

    return model_id, thinking_level, thinking_budget


def get_spec_phase_thinking_budget(phase_name: str) -> int | None:
    """
    Get the thinking budget for a specific spec runner phase.

    This maps granular spec phases (discovery, spec_writing, etc.) to their
    appropriate thinking budgets based on SPEC_PHASE_THINKING_LEVELS.

    Args:
        phase_name: Name of the spec phase (e.g., 'discovery', 'spec_writing')

    Returns:
        Token budget for extended thinking, or None for no extended thinking
    """
    thinking_level = SPEC_PHASE_THINKING_LEVELS.get(phase_name, "medium")
    return get_thinking_budget(thinking_level)
