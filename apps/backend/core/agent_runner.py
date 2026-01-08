"""
Agent Runner
============

Unified interface for running AI agent backends (Claude, Gemini, OpenCode).
Provides a consistent abstraction layer that normalizes differences between
CLI tools while maintaining all functionality.
"""

import asyncio
import logging
import os
import shutil
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from claude_agent_sdk.types import ResultMessage

logger = logging.getLogger(__name__)


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


# Default model for Claude agent
DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5-20250929"


async def _run_claude(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run a Claude agent session using the Claude Agent SDK.

    This function wraps the ClaudeSDKClient to provide a simplified interface
    for running Claude sessions. It handles client creation, message sending,
    response collection, and error handling.

    Args:
        prompt: The message to send to Claude
        project_dir: Working directory for the agent session
        model: Claude model to use (defaults to claude-sonnet-4-5-20250929)
        session_id: Optional session ID to resume a previous conversation
        system_prompt: Optional system prompt to set context for the session

    Returns:
        AgentResult containing success status, output text, session ID, and any error

    Example:
        >>> result = await _run_claude(
        ...     prompt="Create a hello world function in Python",
        ...     project_dir=Path("/my/project"),
        ... )
        >>> if result.success:
        ...     print(result.output)
    """
    resolved_model = model or DEFAULT_CLAUDE_MODEL

    # Default system prompt if none provided
    default_system_prompt = (
        f"You are an expert full-stack developer. "
        f"Your working directory is: {project_dir.resolve()}\n"
        f"Your filesystem access is RESTRICTED to this directory only. "
        f"Use relative paths (starting with ./) for all file operations."
    )

    # Create client options
    options = ClaudeAgentOptions(
        model=resolved_model,
        system_prompt=system_prompt or default_system_prompt,
        cwd=str(project_dir.resolve()),
        max_turns=1000,
        resume=session_id,
    )

    output_text = ""
    result_session_id: str | None = None

    try:
        client = ClaudeSDKClient(options=options)

        async with client:
            # Send the query
            await client.query(prompt)

            # Collect response
            async for msg in client.receive_response():
                msg_type = type(msg).__name__

                # Handle AssistantMessage (text and tool use)
                if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        block_type = type(block).__name__
                        if block_type == "TextBlock" and hasattr(block, "text"):
                            output_text += block.text

                # Handle ResultMessage (captures session_id for resume capability)
                elif isinstance(msg, ResultMessage):
                    result_session_id = msg.session_id
                    logger.debug(
                        "Claude session completed: session_id=%s, duration_ms=%s, num_turns=%s",
                        result_session_id,
                        msg.duration_ms,
                        msg.num_turns,
                    )

        return AgentResult(
            success=True,
            output=output_text,
            session_id=result_session_id,
        )

    except Exception as e:
        error_msg = f"Claude session failed: {e}"
        logger.exception(error_msg)
        return AgentResult(
            success=False,
            output=output_text,  # Include any partial output
            session_id=result_session_id,
            error=error_msg,
        )


# Default model for Gemini agent
DEFAULT_GEMINI_MODEL = "gemini-2.5-pro"


async def _run_gemini(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run a Gemini agent session using the Gemini CLI.

    This function invokes the Gemini CLI tool via subprocess to interact with
    Google's Gemini AI models. It supports session resumption and model selection
    through CLI flags.

    Args:
        prompt: The message to send to Gemini
        project_dir: Working directory for the agent session
        model: Gemini model to use (defaults to gemini-2.5-pro)
        session_id: Optional session ID to resume a previous conversation
        system_prompt: System prompt (set via GEMINI_SYSTEM_PROMPT env var)

    Returns:
        AgentResult containing success status, output text, session ID, and any error

    Note:
        The Gemini CLI must be installed and available in PATH.
        System prompts are passed via environment variable since Gemini CLI
        doesn't support a --system-prompt flag.

    Example:
        >>> result = await _run_gemini(
        ...     prompt="Create a hello world function in Python",
        ...     project_dir=Path("/my/project"),
        ... )
        >>> if result.success:
        ...     print(result.output)
    """
    # Check if gemini CLI is available
    gemini_path = shutil.which("gemini")
    if not gemini_path:
        return AgentResult(
            success=False,
            output="",
            error="Gemini CLI not found. Please install it and ensure it's in your PATH.",
        )

    resolved_model = model or DEFAULT_GEMINI_MODEL

    # Build the command
    cmd = ["gemini"]

    # Add model flag
    cmd.extend(["--model", resolved_model])

    # Add resume flag if session_id provided
    if session_id:
        cmd.extend(["--resume", session_id])

    # Add the prompt
    cmd.append(prompt)

    # Set up environment with system prompt if provided
    env = os.environ.copy()
    if system_prompt:
        env["GEMINI_SYSTEM_PROMPT"] = system_prompt

    output_text = ""
    result_session_id: str | None = None

    try:
        logger.debug(
            "Running Gemini CLI: cmd=%s, cwd=%s",
            " ".join(cmd),
            project_dir.resolve(),
        )

        # Run the gemini command asynchronously
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(project_dir.resolve()),
            env=env,
        )

        stdout, stderr = await process.communicate()

        # Decode output
        output_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")

        # Check for success
        if process.returncode == 0:
            # Try to extract session ID from output if present
            # Gemini CLI may output session info in a specific format
            # For now, we'll attempt to parse it from the output
            result_session_id = _extract_gemini_session_id(output_text, stderr_text)

            logger.debug(
                "Gemini session completed: session_id=%s, return_code=%s",
                result_session_id,
                process.returncode,
            )

            return AgentResult(
                success=True,
                output=output_text,
                session_id=result_session_id,
            )
        else:
            error_msg = f"Gemini CLI returned non-zero exit code: {process.returncode}"
            if stderr_text:
                error_msg += f"\nStderr: {stderr_text}"

            logger.warning(error_msg)

            return AgentResult(
                success=False,
                output=output_text,  # Include any partial output
                session_id=result_session_id,
                error=error_msg,
            )

    except FileNotFoundError:
        error_msg = "Gemini CLI executable not found"
        logger.exception(error_msg)
        return AgentResult(
            success=False,
            output="",
            error=error_msg,
        )
    except Exception as e:
        error_msg = f"Gemini session failed: {e}"
        logger.exception(error_msg)
        return AgentResult(
            success=False,
            output=output_text,  # Include any partial output
            session_id=result_session_id,
            error=error_msg,
        )


def _extract_gemini_session_id(stdout: str, stderr: str) -> str | None:
    """
    Extract session ID from Gemini CLI output.

    The Gemini CLI may output session information in various formats.
    This function attempts to parse and extract the session ID for
    later resumption.

    Args:
        stdout: Standard output from the Gemini CLI
        stderr: Standard error from the Gemini CLI

    Returns:
        The extracted session ID, or None if not found
    """
    import re

    # Common patterns for session IDs in CLI output
    # Pattern 1: "Session ID: <id>" or "session_id: <id>"
    patterns = [
        r"[Ss]ession[_\s][Ii][Dd]:\s*([a-zA-Z0-9_-]+)",
        r"--resume\s+([a-zA-Z0-9_-]+)",
        r'"session_id":\s*"([a-zA-Z0-9_-]+)"',
    ]

    # Check both stdout and stderr
    for text in [stdout, stderr]:
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                return match.group(1)

    return None


# Default model for OpenCode agent
DEFAULT_OPENCODE_MODEL = "anthropic/claude-sonnet-4-20250514"


async def _run_opencode(
    prompt: str,
    project_dir: Path,
    model: str | None = None,
    session_id: str | None = None,
    system_prompt: str | None = None,
) -> AgentResult:
    """
    Run an OpenCode agent session using the OpenCode CLI.

    This function invokes the OpenCode CLI tool via subprocess to interact with
    various AI models through the OpenCode interface. It supports session resumption
    and model selection through CLI flags.

    Args:
        prompt: The message to send to OpenCode
        project_dir: Working directory for the agent session
        model: Model to use in provider/model format (defaults to anthropic/claude-sonnet-4-20250514)
        session_id: Optional session ID to resume a previous conversation
        system_prompt: System prompt (set via OPENCODE_SYSTEM_PROMPT env var)

    Returns:
        AgentResult containing success status, output text, session ID, and any error

    Note:
        The OpenCode CLI must be installed and available in PATH.
        OpenCode uses `opencode run` as the command (not just `opencode`).
        Session resumption uses `--session` flag (not `--resume`).
        System prompts are passed via environment variable since OpenCode CLI
        doesn't support a --system-prompt flag.

    Example:
        >>> result = await _run_opencode(
        ...     prompt="Create a hello world function in Python",
        ...     project_dir=Path("/my/project"),
        ... )
        >>> if result.success:
        ...     print(result.output)
    """
    # Check if opencode CLI is available
    opencode_path = shutil.which("opencode")
    if not opencode_path:
        return AgentResult(
            success=False,
            output="",
            error="OpenCode CLI not found. Please install it and ensure it's in your PATH.",
        )

    resolved_model = model or DEFAULT_OPENCODE_MODEL

    # Build the command - opencode uses "opencode run" as the command
    cmd = ["opencode", "run"]

    # Add model flag (format: provider/model)
    cmd.extend(["--model", resolved_model])

    # Add session flag if session_id provided (opencode uses --session, not --resume)
    if session_id:
        cmd.extend(["--session", session_id])

    # Add the prompt
    cmd.append(prompt)

    # Set up environment with system prompt if provided
    env = os.environ.copy()
    if system_prompt:
        env["OPENCODE_SYSTEM_PROMPT"] = system_prompt

    output_text = ""
    result_session_id: str | None = None

    try:
        logger.debug(
            "Running OpenCode CLI: cmd=%s, cwd=%s",
            " ".join(cmd),
            project_dir.resolve(),
        )

        # Run the opencode command asynchronously
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(project_dir.resolve()),
            env=env,
        )

        stdout, stderr = await process.communicate()

        # Decode output
        output_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")

        # Check for success
        if process.returncode == 0:
            # Try to extract session ID from output if present
            result_session_id = _extract_opencode_session_id(output_text, stderr_text)

            logger.debug(
                "OpenCode session completed: session_id=%s, return_code=%s",
                result_session_id,
                process.returncode,
            )

            return AgentResult(
                success=True,
                output=output_text,
                session_id=result_session_id,
            )
        else:
            error_msg = f"OpenCode CLI returned non-zero exit code: {process.returncode}"
            if stderr_text:
                error_msg += f"\nStderr: {stderr_text}"

            logger.warning(error_msg)

            return AgentResult(
                success=False,
                output=output_text,  # Include any partial output
                session_id=result_session_id,
                error=error_msg,
            )

    except FileNotFoundError:
        error_msg = "OpenCode CLI executable not found"
        logger.exception(error_msg)
        return AgentResult(
            success=False,
            output="",
            error=error_msg,
        )
    except Exception as e:
        error_msg = f"OpenCode session failed: {e}"
        logger.exception(error_msg)
        return AgentResult(
            success=False,
            output=output_text,  # Include any partial output
            session_id=result_session_id,
            error=error_msg,
        )


def _extract_opencode_session_id(stdout: str, stderr: str) -> str | None:
    """
    Extract session ID from OpenCode CLI output.

    The OpenCode CLI may output session information in various formats.
    This function attempts to parse and extract the session ID for
    later resumption.

    Args:
        stdout: Standard output from the OpenCode CLI
        stderr: Standard error from the OpenCode CLI

    Returns:
        The extracted session ID, or None if not found
    """
    import re

    # Common patterns for session IDs in CLI output
    # OpenCode uses --session flag, so look for related patterns
    patterns = [
        r"[Ss]ession[_\s][Ii][Dd]:\s*([a-zA-Z0-9_-]+)",
        r"--session\s+([a-zA-Z0-9_-]+)",
        r'"session_id":\s*"([a-zA-Z0-9_-]+)"',
        r'"session":\s*"([a-zA-Z0-9_-]+)"',
        # OpenCode may use UUID-style session IDs
        r"session[:\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})",
    ]

    # Check both stdout and stderr
    for text in [stdout, stderr]:
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return match.group(1)

    return None
