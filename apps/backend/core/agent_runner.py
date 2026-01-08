"""
Agent Runner
============

Unified interface for running AI agent backends (Claude, Gemini, OpenCode).
Provides a consistent abstraction layer that normalizes differences between
CLI tools while maintaining all functionality.
"""

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal


class AgentType(str, Enum):
    """Supported AI agent backends."""

    CLAUDE = "claude"
    GEMINI = "gemini"
    OPENCODE = "opencode"


@dataclass
class AgentResult:
    """
    Result from running an AI agent session.

    Provides a consistent structure for all agent backends, normalizing
    the different output formats and error handling approaches.
    """

    success: bool
    """Whether the agent session completed successfully."""

    output: str
    """The full output/response text from the agent."""

    session_id: str | None = None
    """Session ID for resuming the conversation (if supported by the agent)."""

    error: str | None = None
    """Error message if the session failed."""

    def __post_init__(self):
        """Validate result state consistency."""
        if not self.success and not self.error:
            self.error = "Unknown error occurred"


AgentTypeLiteral = Literal["claude", "gemini", "opencode"]


async def run_agent(
    agent_type: AgentTypeLiteral,
    prompt: str,
    project_dir: Path,
    *,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run an AI agent session with the specified backend.

    This is the unified dispatcher function that routes to the appropriate
    agent-specific runner based on the agent_type parameter.

    Args:
        agent_type: Which agent backend to use ("claude", "gemini", or "opencode")
        prompt: The prompt/message to send to the agent
        project_dir: Working directory for the agent session
        model: Optional model override (uses agent's default if not specified)
        session_id: Optional session ID to resume a previous conversation
        system_prompt: Optional system prompt (handling varies by agent)

    Returns:
        AgentResult with success status, output, session_id, and any error

    Raises:
        ValueError: If agent_type is not supported

    Example:
        >>> result = await run_agent(
        ...     agent_type="claude",
        ...     prompt="Create a hello world function",
        ...     project_dir=Path("/my/project"),
        ... )
        >>> if result.success:
        ...     print(result.output)
        ... else:
        ...     print(f"Error: {result.error}")
    """
    # Normalize agent type to enum if needed
    if isinstance(agent_type, str):
        try:
            agent_type_enum = AgentType(agent_type.lower())
        except ValueError:
            return AgentResult(
                success=False,
                output="",
                error=f"Unsupported agent type: {agent_type}. "
                f"Supported types: {', '.join(t.value for t in AgentType)}",
            )
    else:
        agent_type_enum = agent_type

    # Dispatch to agent-specific runner
    # These will be implemented in subtasks 1.2-1.4
    if agent_type_enum == AgentType.CLAUDE:
        return await _run_claude(
            prompt=prompt,
            project_dir=project_dir,
            model=model,
            session_id=session_id,
            system_prompt=system_prompt,
        )
    elif agent_type_enum == AgentType.GEMINI:
        return await _run_gemini(
            prompt=prompt,
            project_dir=project_dir,
            model=model,
            session_id=session_id,
            system_prompt=system_prompt,
        )
    elif agent_type_enum == AgentType.OPENCODE:
        return await _run_opencode(
            prompt=prompt,
            project_dir=project_dir,
            model=model,
            session_id=session_id,
            system_prompt=system_prompt,
        )
    else:
        return AgentResult(
            success=False,
            output="",
            error=f"Agent type not implemented: {agent_type_enum.value}",
        )


# Placeholder implementations - to be completed in subtasks 1.2-1.4


async def _run_claude(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run a Claude agent session using the Claude Agent SDK.

    To be implemented in subtask 1.2.
    """
    return AgentResult(
        success=False,
        output="",
        error="Claude runner not yet implemented (subtask 1.2)",
    )


async def _run_gemini(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run a Gemini agent session using the Gemini CLI.

    To be implemented in subtask 1.3.
    """
    return AgentResult(
        success=False,
        output="",
        error="Gemini runner not yet implemented (subtask 1.3)",
    )


async def _run_opencode(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run an OpenCode agent session using the OpenCode CLI.

    To be implemented in subtask 1.4.
    """
    return AgentResult(
        success=False,
        output="",
        error="OpenCode runner not yet implemented (subtask 1.4)",
    )
