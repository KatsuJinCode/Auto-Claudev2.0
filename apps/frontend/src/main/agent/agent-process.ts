import { spawn, execSync, ChildProcess, SpawnOptions, StdioOptions } from 'child_process';
import path from 'path';
import * as fs from 'fs';
import { existsSync, readFileSync } from 'fs';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { getAgentRegistry, AgentRegistryEntry } from './agent-registry';
import { projectStore } from '../project-store';
import { findPythonCommand } from '../python-detector';
import { ensureDir } from '../fs-utils';

/**
 * Quote arguments containing spaces for Windows shell mode
 * When using shell:true on Windows, cmd.exe requires paths with spaces to be quoted
 *
 * @param args - Array of command arguments
 * @param useShell - Whether shell mode is being used
 * @returns Array of arguments with spaces-containing args quoted
 */
export function quoteArgsForShell(args: string[], useShell: boolean): string[] {
  if (!useShell) return args;
  // On Windows with shell:true and cmd.exe, use double-double-quotes for escaping
  // cmd.exe interprets "" as a literal " inside a quoted string
  return args.map(arg => {
    if (!arg.includes(' ') && !arg.includes('"')) return arg;
    // Escape any existing quotes with doubled quotes and wrap in quotes
    const escaped = arg.replace(/"/g, '""');
    return `"${escaped}"`;
  });
}


/**
 * Get the default output file path for an agent
 *
 * Output files are stored at: .auto-claude/agent-output/{specId}.log
 *
 * @param cwd - The working directory (project root)
 * @param specId - The spec ID for the agent
 * @returns Full path to the output log file
 */
export function getAgentOutputFilePath(cwd: string, specId: string): string {
  return path.join(cwd, '.auto-claude', 'agent-output', `${specId}.log`);
}

/**
 * Get the output directory path for all agent output files
 *
 * @param cwd - The working directory (project root)
 * @returns Full path to the agent output directory
 */
export function getAgentOutputDir(cwd: string): string {
  return path.join(cwd, '.auto-claude', 'agent-output');
}

/**
 * Options for spawning a detached agent process
 */
export interface SpawnAgentOptions {
  /** Spec ID - used for lockfile naming, output file, and registry tracking */
  specId: string;
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory for the process */
  cwd: string;
  /** Environment variables to pass to the process */
  env?: Record<string, string>;
  /**
   * Path to the output file for stdout/stderr
   * If not provided, defaults to .auto-claude/agent-output/{specId}.log
   * Set to null to disable file output (stdio will be ignored)
   */
  outputFile?: string | null;
  /** Optional session ID for the Claude conversation */
  sessionId?: string;
  /**
   * Whether to register the agent in the registry
   * Set to false to skip registry registration (useful for non-persistent processes)
   * Defaults to true
   */
  registerInRegistry?: boolean;
  /**
   * Whether to use shell mode on Windows for CTRL event support.
   *
   * On Windows, using shell:true spawns the process through cmd.exe, which ensures
   * that CTRL_BREAK_EVENT (sent via SIGBREAK signal) can reach the process for
   * graceful shutdown. This is important for killAgentProcess() to work correctly.
   *
   * Trade-offs:
   * - Pro: Ensures CTRL_BREAK_EVENT works for graceful shutdown
   * - Con: Adds cmd.exe layer, may affect argument parsing
   * - Con: Creates additional process (cmd.exe -> actual process)
   *
   * On Unix, this option is ignored (shell is not needed for signal delivery).
   *
   * Defaults to true on Windows for CTRL event support, false on Unix.
   */
  windowsShell?: boolean;
}

/**
 * Result from spawning a detached agent process
 */
export interface SpawnAgentResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Process ID of the spawned process */
  pid: number;
  /** Unique execution ID (UUID) for PID reuse protection */
  executionId: string;
  /** Path to the lockfile containing the executionId */
  lockFile: string;
  /** Path to the output file (if using file output) */
  outputFile?: string;
}

/**
 * Result from attempting to kill an agent process
 */
export interface KillAgentResult {
  /** Whether the kill signal was sent successfully */
  success: boolean;
  /** Error message if the kill failed */
  error?: string;
  /** The signal that was sent */
  signal: NodeJS.Signals | 'SIGBREAK';
  /** Whether the process is confirmed terminated */
  terminated?: boolean;
}

/**
 * Options for force killing an agent process
 */
export interface ForceKillOptions {
  /**
   * Whether to attempt graceful shutdown first before force kill
   * If true, sends SIGTERM/SIGBREAK first, then waits for timeout before SIGKILL/taskkill
   * Defaults to true
   */
  gracefulFirst?: boolean;
  /**
   * Timeout in milliseconds to wait for graceful shutdown before force kill
   * Only used when gracefulFirst is true
   * Defaults to 5000 (5 seconds)
   */
  gracefulTimeout?: number;
  /**
   * Interval in milliseconds to poll for process exit during graceful wait
   * Defaults to 100
   */
  pollInterval?: number;
}

/**
 * Result from attempting to force kill an agent process
 */
export interface ForceKillAgentResult {
  /** Whether the process was successfully terminated */
  success: boolean;
  /** Error message if the kill failed */
  error?: string;
  /** Method used to terminate: 'graceful' if process exited during graceful wait, 'force' if SIGKILL/taskkill was needed */
  method: 'graceful' | 'force' | 'already_dead';
  /** Whether the process is confirmed terminated */
  terminated: boolean;
  /** Time in milliseconds it took to terminate the process */
  elapsedMs?: number;
}

/**
 * Check if a process is running by attempting to send signal 0
 * Signal 0 doesn't actually send a signal, but tests if the process exists
 *
 * @param pid - The process ID to check
 * @returns true if the process is running, false otherwise
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 is a special case - it checks if the process exists
    // without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // ESRCH = No such process (process doesn't exist)
    // EPERM = Operation not permitted (process exists but we can't signal it)
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      // Process exists but we don't have permission to signal it
      // This counts as "running" for our purposes
      return true;
    }
    // ESRCH or any other error means process doesn't exist
    return false;
  }
}

/**
 * Kill a detached agent process using platform-specific signals
 *
 * This function sends a graceful shutdown signal to the agent:
 * - On Windows: Sends CTRL_BREAK_EVENT (via SIGBREAK) which allows the process
 *   to handle the signal and shut down gracefully
 * - On Unix: Sends SIGTERM which is the standard graceful termination signal
 *
 * If the process doesn't respond, use forceKillAgentProcess() which uses
 * taskkill /F on Windows or SIGKILL on Unix.
 *
 * @param pid - The process ID of the agent to kill
 * @returns Result indicating success or failure with details
 */
export function killAgentProcess(pid: number): KillAgentResult {
  const isWindows = process.platform === 'win32';

  // On Windows with shell:true, SIGBREAK sends CTRL_BREAK_EVENT for graceful shutdown
  // On Unix, SIGTERM is the standard graceful termination signal
  const signal: NodeJS.Signals = isWindows ? 'SIGBREAK' : 'SIGTERM';

  try {
    // Check if the process is running first
    if (!isProcessRunning(pid)) {
      return {
        success: true,
        signal,
        terminated: true,
        error: 'Process was not running'
      };
    }

    // Send the kill signal
    // On Windows with SIGBREAK, this sends CTRL_BREAK_EVENT to the process group
    // On Unix with SIGTERM, this sends the termination signal to the process
    process.kill(pid, signal);

    return {
      success: true,
      signal,
      terminated: false // Signal sent, but process may still be running
    };
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    const errorMessage = nodeError.message || String(error);

    // Handle specific error codes
    if (nodeError.code === 'ESRCH') {
      // Process doesn't exist - consider this a success (already terminated)
      return {
        success: true,
        signal,
        terminated: true,
        error: 'Process not found (already terminated)'
      };
    }

    if (nodeError.code === 'EPERM') {
      // Permission denied - we can't kill this process
      return {
        success: false,
        signal,
        error: `Permission denied to kill process ${pid}`
      };
    }

    // Generic error
    return {
      success: false,
      signal,
      error: `Failed to kill process ${pid}: ${errorMessage}`
    };
  }
}

/**
 * Wait for a process to exit, polling at regular intervals
 *
 * @param pid - The process ID to wait for
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param pollIntervalMs - How often to check if process is still running
 * @returns true if process exited within timeout, false if still running
 */
async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Final check after timeout
  return !isProcessRunning(pid);
}

/**
 * Force kill a process on Windows using taskkill /F
 *
 * This is more reliable than SIGKILL on Windows for forcefully terminating processes.
 * The /F flag forces termination, and /T also kills child processes.
 *
 * @param pid - The process ID to terminate
 * @returns Object with success status and any error message
 */
function windowsForceKill(pid: number): { success: boolean; error?: string } {
  try {
    // Use taskkill with /F (force) and /T (terminate child processes)
    // /PID specifies the process ID to terminate
    // Suppress output by redirecting to nul, errors will still throw
    execSync(`taskkill /F /T /PID ${pid}`, {
      stdio: 'pipe', // Capture output to prevent it from appearing in console
      windowsHide: true // Don't show a command window
    });
    return { success: true };
  } catch (error: unknown) {
    // taskkill returns exit code 128 when process not found, which is fine
    // It also throws when process doesn't exist, which we treat as success
    const execError = error as { status?: number; message?: string; stderr?: Buffer };

    // Check if the error is because process doesn't exist
    const stderr = execError.stderr?.toString() || '';
    if (
      execError.status === 128 ||
      stderr.includes('not found') ||
      stderr.includes('ERROR: The process') ||
      stderr.includes('ERROR: No tasks running')
    ) {
      // Process already terminated - this is fine
      return { success: true };
    }

    // Actual error
    const errorMessage = execError.message || String(error);
    return {
      success: false,
      error: `taskkill failed: ${errorMessage}`
    };
  }
}

/**
 * Force kill a detached agent process using platform-specific forceful termination
 *
 * This function provides a more aggressive way to terminate processes that don't
 * respond to graceful shutdown signals (SIGTERM/SIGBREAK):
 *
 * - On Unix: Uses SIGKILL which cannot be caught, blocked, or ignored
 * - On Windows: Uses `taskkill /F /T /PID` which forcefully terminates the process
 *   and any child processes
 *
 * Options:
 * - gracefulFirst: If true (default), attempts graceful shutdown first, then waits
 *   for gracefulTimeout before force killing
 * - gracefulTimeout: Time in ms to wait for graceful shutdown (default: 5000ms)
 *
 * @param pid - The process ID of the agent to force kill
 * @param options - Configuration options for the force kill
 * @returns Promise resolving to result indicating success and method used
 *
 * @example
 * // Immediate force kill without waiting
 * const result = await forceKillAgentProcess(12345, { gracefulFirst: false });
 *
 * @example
 * // Graceful first with 3 second timeout, then force kill
 * const result = await forceKillAgentProcess(12345, { gracefulTimeout: 3000 });
 */
export async function forceKillAgentProcess(
  pid: number,
  options: ForceKillOptions = {}
): Promise<ForceKillAgentResult> {
  const { gracefulFirst = true, gracefulTimeout = 5000, pollInterval = 100 } = options;

  const startTime = Date.now();
  const isWindows = process.platform === 'win32';

  // Check if process is already dead
  if (!isProcessRunning(pid)) {
    return {
      success: true,
      method: 'already_dead',
      terminated: true,
      elapsedMs: Date.now() - startTime
    };
  }

  // Attempt graceful shutdown first if requested
  if (gracefulFirst) {
    const gracefulResult = killAgentProcess(pid);

    // If process was already dead or error occurred, check current state
    if (gracefulResult.terminated) {
      return {
        success: true,
        method: 'already_dead',
        terminated: true,
        elapsedMs: Date.now() - startTime
      };
    }

    if (gracefulResult.success) {
      // Wait for process to exit gracefully
      const exitedGracefully = await waitForProcessExit(pid, gracefulTimeout, pollInterval);

      if (exitedGracefully) {
        return {
          success: true,
          method: 'graceful',
          terminated: true,
          elapsedMs: Date.now() - startTime
        };
      }
      // Process didn't exit gracefully, continue to force kill
    }
    // If graceful signal failed, still try force kill
  }

  // Force kill the process
  try {
    if (isWindows) {
      // Use taskkill on Windows for reliable force termination
      const result = windowsForceKill(pid);

      if (!result.success) {
        return {
          success: false,
          method: 'force',
          terminated: false,
          error: result.error,
          elapsedMs: Date.now() - startTime
        };
      }
    } else {
      // Use SIGKILL on Unix - cannot be caught or ignored
      process.kill(pid, 'SIGKILL');
    }

    // Brief wait to confirm termination (SIGKILL and taskkill are usually immediate)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify process is dead
    const isDead = !isProcessRunning(pid);

    return {
      success: isDead,
      method: 'force',
      terminated: isDead,
      error: isDead ? undefined : 'Process did not terminate after force kill',
      elapsedMs: Date.now() - startTime
    };
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    const errorMessage = nodeError.message || String(error);

    // ESRCH means process doesn't exist - success
    if (nodeError.code === 'ESRCH') {
      return {
        success: true,
        method: 'force',
        terminated: true,
        elapsedMs: Date.now() - startTime
      };
    }

    // EPERM means permission denied
    if (nodeError.code === 'EPERM') {
      return {
        success: false,
        method: 'force',
        terminated: false,
        error: `Permission denied to force kill process ${pid}`,
        elapsedMs: Date.now() - startTime
      };
    }

    return {
      success: false,
      method: 'force',
      terminated: false,
      error: `Failed to force kill process ${pid}: ${errorMessage}`,
      elapsedMs: Date.now() - startTime
    };
  }
}

/**
 * Spawn a detached agent process that survives GUI restart
 *
 * This function creates a fully independent process that:
 * - Continues running after the parent process exits (detached: true)
 * - Doesn't show a console window on Windows (windowsHide: true)
 * - Writes output to a file for later reading (when outputFile is provided)
 * - Uses platform-specific settings for process control signal support
 *
 * Platform-specific behavior:
 * - **Windows**: Uses shell:true by default (configurable via windowsShell option)
 *   to ensure CTRL_BREAK_EVENT can reach the process for graceful shutdown.
 *   The windowsHide:true option prevents a visible console window.
 * - **Unix**: Uses shell:false (signals like SIGTERM work directly without shell).
 *   No special handling needed for graceful shutdown.
 *
 * Important: After spawning, child.unref() is called automatically to allow
 * the parent to exit without waiting for the child process.
 *
 * @param options - Configuration for the spawned process
 * @returns The spawned process and its PID
 * @throws Error if the process fails to spawn or has no PID
 *
 * @example
 * // Spawn with default Windows CTRL event support
 * const result = spawnAgentProcess({
 *   specId: 'my-task',
 *   command: 'python',
 *   args: ['-m', 'my_module'],
 *   cwd: '/path/to/project'
 * });
 *
 * @example
 * // Disable Windows shell mode if CTRL events not needed
 * const result = spawnAgentProcess({
 *   specId: 'my-task',
 *   command: 'python',
 *   args: ['-m', 'my_module'],
 *   cwd: '/path/to/project',
 *   windowsShell: false
 * });
 */
export function spawnAgentProcess(options: SpawnAgentOptions): SpawnAgentResult {
  const { specId, command, args, cwd, env = {} } = options;

  // Determine output file path:
  // - If explicitly provided as string, use that path
  // - If undefined (not provided), auto-generate at .auto-claude/agent-output/{specId}.log
  // - If null, disable file output (stdio will be ignored)
  let outputFile: string | undefined;
  if (options.outputFile === null) {
    // Explicitly disabled - no output file
    outputFile = undefined;
  } else if (options.outputFile !== undefined) {
    // Custom path provided
    outputFile = options.outputFile;
  } else {
    // Auto-generate default path using helper function
    outputFile = getAgentOutputFilePath(cwd, specId);
  }

  // Generate unique execution ID (UUID) for PID reuse protection
  // This ID is written to a lockfile and validated on reconnection
  const executionId = uuidv4();

  // Create lockfile path at .auto-claude/agent-locks/{specId}.lock
  const locksDir = path.join(cwd, '.auto-claude', 'agent-locks');
  const lockFile = path.join(locksDir, `${specId}.lock`);

  // Ensure locks directory exists
  if (!ensureDir(locksDir)) {
    throw new Error(`Failed to create agent locks directory: ${locksDir}`);
  }

  // Write lockfile with executionId before spawning
  // This allows the agent process to read it and for later validation
  try {
    const lockfileContent = JSON.stringify(
      {
        executionId,
        specId,
        createdAt: new Date().toISOString()
      },
      null,
      2
    );
    fs.writeFileSync(lockFile, lockfileContent, { encoding: 'utf-8', mode: 0o600 });

    // Set restrictive permissions on Unix (owner read/write only)
    if (process.platform !== 'win32') {
      fs.chmodSync(lockFile, 0o600);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write lockfile ${lockFile}: ${errorMessage}`);
  }

  // Determine platform-specific spawn options
  const isWindows = process.platform === 'win32';

  // Build environment variables
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    // Ensure Python output is unbuffered for real-time logging
    PYTHONUNBUFFERED: '1',
    // Ensure UTF-8 encoding on Windows
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  };

  // Configure stdio based on whether we have an output file
  let stdio: StdioOptions;
  let outputFd: number | undefined;

  if (outputFile) {
    // Open file for writing with shared read access
    // This allows the GUI to read the file while the agent writes to it
    //
    // On Windows, file sharing is critical to avoid EBUSY errors:
    // - Using explicit flags: O_WRONLY | O_CREAT | O_TRUNC
    // - Node.js on Windows uses FILE_SHARE_READ | FILE_SHARE_WRITE by default
    //   which allows other processes to read while we write
    // - The reader (GUI) must also open with read-only flags to avoid conflicts
    //
    // On Unix, file sharing is more permissive by default
    try {
      // Ensure output directory exists (e.g., .auto-claude/agent-output/)
      const outputDir = path.dirname(outputFile);
      if (!ensureDir(outputDir)) {
        throw new Error(`Failed to create output directory: ${outputDir}`);
      }

      // Open file with explicit flags for shared access:
      // - O_WRONLY: Write-only access
      // - O_CREAT: Create file if it doesn't exist
      // - O_TRUNC: Truncate file to zero length if it exists
      // This combination allows the GUI to read the file while the agent writes
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;

      // Mode 0o666: rw-rw-rw- (modified by umask on Unix)
      // On Windows, mode is largely ignored but we specify it for consistency
      outputFd = fs.openSync(outputFile, flags, 0o666);

      // Set up stdio: [stdin, stdout, stderr]
      // stdin: ignore (no input needed)
      // stdout: write to file
      // stderr: write to same file (merged output for unified logging)
      stdio = ['ignore', outputFd, outputFd];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Clean up lockfile on output file error
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Ignore lockfile cleanup errors
      }
      throw new Error(`Failed to open output file ${outputFile}: ${errorMessage}`);
    }
  } else {
    // No output file - use 'ignore' for all stdio to fully detach
    // The process should write its own logs if needed
    stdio = ['ignore', 'ignore', 'ignore'];
  }

  // Use shell mode on Windows for proper output capture and CTRL_BREAK_EVENT support
  // Note: This shows a visible cmd.exe window. Future enhancement: embed output in UI
  // via Running Agents view instead of external window.
  const useShell = isWindows && (options.windowsShell !== false);

  // Spawn options for detached process
  const spawnOptions: SpawnOptions = {
    cwd,
    env: spawnEnv,
    // Detach the process so it continues running after parent exits
    detached: true,
    // Hide console window on Windows - works better without shell:true
    windowsHide: isWindows,
    // Configure stdio for file output or ignore
    stdio,
    // Shell mode: now defaults to false on Windows to hide console window
    // Graceful shutdown handled via taskkill/SIGTERM instead of CTRL_BREAK_EVENT
    shell: useShell
  };


  // Quote command and arguments with spaces for Windows shell mode
  const quotedArgs = quoteArgsForShell(args, useShell);
  // Also quote the command if it has spaces (e.g., path to python.exe in a directory with spaces)
  const quotedCommand = useShell && command.includes(' ') ? `"${command}"` : command;

  // Spawn the detached process
  const childProcess = spawn(quotedCommand, quotedArgs, spawnOptions);

  // Verify we got a valid PID
  if (childProcess.pid === undefined) {
    // Clean up file descriptor if we opened one
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close errors
      }
    }
    // Clean up lockfile since spawn failed
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Ignore lockfile cleanup errors
    }
    throw new Error('Failed to spawn agent process: no PID returned');
  }

  // Allow the parent process (GUI) to exit without waiting for this child
  // This is critical for detached processes - without unref(), Node will keep
  // the parent alive until the child exits, defeating the purpose of detached: true
  //
  // Per Node.js docs: "By default, the parent will wait for the detached child to exit.
  // To prevent the parent from waiting for a given subprocess to exit, use the
  // subprocess.unref() method."
  childProcess.unref();

  // Register agent in registry (unless explicitly disabled)
  // This enables the GUI to discover and reconnect to this agent after restart
  const shouldRegister = options.registerInRegistry !== false;

  if (shouldRegister) {
    const now = new Date().toISOString();
    const registryEntry: AgentRegistryEntry = {
      pid: childProcess.pid,
      executionId,
      specId,
      sessionId: options.sessionId,
      startedAt: now,
      lastHeartbeat: now,
      status: 'running',
      outputFile: outputFile || '',
      lockFile,
      workingDirectory: cwd
    };

    try {
      const registry = getAgentRegistry();
      const registered = registry.registerAgent(registryEntry);

      if (!registered) {
        // Registration failed (save error) - log warning but don't fail spawn
        // The process is already running, so we should return success
        console.warn(
          `[spawnAgentProcess] Failed to save registry entry for specId '${specId}'. ` +
            'Agent will run but may not be discoverable after GUI restart.'
        );
      }
    } catch (error) {
      // Registration threw an error (e.g., duplicate running agent)
      // This is a critical error - we should clean up and fail
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[spawnAgentProcess] Failed to register agent in registry: ${errorMessage}`
      );

      // Kill the spawned process since we can't track it properly
      try {
        childProcess.kill();
      } catch {
        // Ignore kill errors
      }

      // Clean up resources
      if (outputFd !== undefined) {
        try {
          fs.closeSync(outputFd);
        } catch {
          // Ignore close errors
        }
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Ignore lockfile cleanup errors
      }

      throw new Error(`Failed to register agent in registry: ${errorMessage}`);
    }
  }

  return {
    process: childProcess,
    pid: childProcess.pid,
    executionId,
    lockFile,
    outputFile
  };
}

/**
 * Process spawning and lifecycle management
 */
export class AgentProcessManager {
  private state: AgentState;
  private events: AgentEvents;
  private emitter: EventEmitter;
  // Auto-detect Python command on initialization
  private pythonPath: string = findPythonCommand() || 'python';
  private autoBuildSourcePath: string = '';

  constructor(state: AgentState, events: AgentEvents, emitter: EventEmitter) {
    this.state = state;
    this.events = events;
    this.emitter = emitter;
  }

  /**
   * Configure paths for Python and auto-claude source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    if (pythonPath) {
      this.pythonPath = pythonPath;
    }
    if (autoBuildSourcePath) {
      this.autoBuildSourcePath = autoBuildSourcePath;
    }
  }

  /**
   * Get the configured Python path
   */
  getPythonPath(): string {
    return this.pythonPath;
  }

  /**
   * Get the auto-claude source path (detects automatically if not configured)
   */
  getAutoBuildSourcePath(): string | null {
    // If manually configured, use that
    if (this.autoBuildSourcePath && existsSync(this.autoBuildSourcePath)) {
      return this.autoBuildSourcePath;
    }

    // Auto-detect from app location
    const possiblePaths = [
      // Dev mode: from dist/main -> ../../backend (apps/frontend/out/main -> apps/backend)
      path.resolve(__dirname, '..', '..', '..', 'backend'),
      // Alternative: from app root -> apps/backend
      path.resolve(app.getAppPath(), '..', 'backend'),
      // If running from repo root with apps structure
      path.resolve(process.cwd(), 'apps', 'backend')
    ];

    for (const p of possiblePaths) {
      // Use requirements.txt as marker - it always exists in auto-claude source
      if (existsSync(p) && existsSync(path.join(p, 'requirements.txt'))) {
        return p;
      }
    }
    return null;
  }

  /**
   * Get project-specific environment variables based on project settings
   */
  private getProjectEnvVars(projectPath: string): Record<string, string> {
    const env: Record<string, string> = {};

    // Find project by path
    const projects = projectStore.getProjects();
    const project = projects.find((p) => p.path === projectPath);

    if (project?.settings) {
      // Graphiti MCP integration
      if (project.settings.graphitiMcpEnabled) {
        const graphitiUrl = project.settings.graphitiMcpUrl || 'http://localhost:8000/mcp/';
        env['GRAPHITI_MCP_URL'] = graphitiUrl;
      }
    }

    return env;
  }

  /**
   * Load environment variables from auto-claude .env file
   */
  loadAutoBuildEnv(): Record<string, string> {
    const autoBuildSource = this.getAutoBuildSourcePath();
    if (!autoBuildSource) {
      return {};
    }

    const envPath = path.join(autoBuildSource, '.env');
    if (!existsSync(envPath)) {
      return {};
    }

    try {
      const envContent = readFileSync(envPath, 'utf-8');
      const envVars: Record<string, string> = {};

      // Handle both Unix (\n) and Windows (\r\n) line endings
      for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();

          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }

          envVars[key] = value;
        }
      }

      return envVars;
    } catch {
      return {};
    }
  }

  /**
   * Kill a specific task's process
   */
  killProcess(taskId: string): boolean {
    const agentProcess = this.state.getProcess(taskId);
    if (agentProcess) {
      try {
        // Mark this specific spawn as killed so its exit handler knows to ignore
        this.state.markSpawnAsKilled(agentProcess.spawnId);

        // Send SIGTERM first for graceful shutdown
        agentProcess.process.kill('SIGTERM');

        // Force kill after timeout
        setTimeout(() => {
          if (!agentProcess.process.killed) {
            agentProcess.process.kill('SIGKILL');
          }
        }, 5000);

        this.state.deleteProcess(taskId);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Kill all running processes
   */
  async killAllProcesses(): Promise<void> {
    const killPromises = this.state.getRunningTaskIds().map((taskId) => {
      return new Promise<void>((resolve) => {
        this.killProcess(taskId);
        resolve();
      });
    });
    await Promise.all(killPromises);
  }

  /**
   * Get combined environment variables for a project
   */
  getCombinedEnv(projectPath: string): Record<string, string> {
    const autoBuildEnv = this.loadAutoBuildEnv();
    const projectEnv = this.getProjectEnvVars(projectPath);
    return { ...autoBuildEnv, ...projectEnv };
  }
}
