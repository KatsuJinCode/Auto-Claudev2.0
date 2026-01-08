import { spawn, ChildProcess, SpawnOptions, StdioOptions } from 'child_process';
import path from 'path';
import * as fs from 'fs';
import { existsSync, readFileSync } from 'fs';
import { app } from 'electron';
import { EventEmitter } from 'events';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { ProcessType, ExecutionProgressData } from './types';
import { detectRateLimit, createSDKRateLimitInfo, getProfileEnv, detectAuthFailure } from '../rate-limit-detector';
import { projectStore } from '../project-store';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { findPythonCommand, parsePythonCommand } from '../python-detector';

/**
 * Options for spawning a detached agent process
 */
export interface SpawnAgentOptions {
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory for the process */
  cwd: string;
  /** Environment variables to pass to the process */
  env?: Record<string, string>;
  /** Path to the output file for stdout/stderr (optional - if not provided, stdio is inherited) */
  outputFile?: string;
}

/**
 * Result from spawning a detached agent process
 */
export interface SpawnAgentResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Process ID of the spawned process */
  pid: number;
  /** Path to the output file (if using file output) */
  outputFile?: string;
}

/**
 * Spawn a detached agent process that survives GUI restart
 *
 * This function creates a fully independent process that:
 * - Continues running after the parent process exits (detached: true)
 * - Doesn't show a console window on Windows (windowsHide: true)
 * - Writes output to a file for later reading (when outputFile is provided)
 *
 * Important: After spawning, call child.unref() to allow the parent
 * to exit without waiting for the child process.
 *
 * @param options - Configuration for the spawned process
 * @returns The spawned process and its PID
 * @throws Error if the process fails to spawn or has no PID
 */
export function spawnAgentProcess(options: SpawnAgentOptions): SpawnAgentResult {
  const { command, args, cwd, env = {}, outputFile } = options;

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
    // Using flags: O_WRONLY | O_CREAT | O_TRUNC for write-only, create if not exists, truncate
    // On Windows, we need to be careful about file sharing
    try {
      // Ensure directory exists
      const outputDir = path.dirname(outputFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Open file with write permissions
      // Using 'w' flag which is O_WRONLY | O_CREAT | O_TRUNC
      outputFd = fs.openSync(outputFile, 'w');

      // Set up stdio: [stdin, stdout, stderr]
      // stdin: ignore (no input needed)
      // stdout: write to file
      // stderr: write to same file (merged output)
      stdio = ['ignore', outputFd, outputFd];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open output file ${outputFile}: ${errorMessage}`);
    }
  } else {
    // No output file - use 'ignore' for all stdio to fully detach
    // The process should write its own logs if needed
    stdio = ['ignore', 'ignore', 'ignore'];
  }

  // Spawn options for detached process
  const spawnOptions: SpawnOptions = {
    cwd,
    env: spawnEnv,
    // Detach the process so it continues running after parent exits
    detached: true,
    // Hide console window on Windows
    windowsHide: isWindows,
    // Configure stdio for file output or ignore
    stdio
  };

  // Spawn the detached process
  const childProcess = spawn(command, args, spawnOptions);

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
    throw new Error('Failed to spawn agent process: no PID returned');
  }

  return {
    process: childProcess,
    pid: childProcess.pid,
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
   * Spawn a Python process for task execution
   */
  spawnProcess(
    taskId: string,
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    processType: ProcessType = 'task-execution'
  ): void {
    const isSpecRunner = processType === 'spec-creation';
    // Kill existing process for this task if any
    this.killProcess(taskId);

    // Generate unique spawn ID for this process instance
    const spawnId = this.state.generateSpawnId();

    // Get active Claude profile environment (CLAUDE_CONFIG_DIR if not default)
    const profileEnv = getProfileEnv();

    // Parse Python command to handle space-separated commands like "py -3"
    const [pythonCommand, pythonBaseArgs] = parsePythonCommand(this.pythonPath);
    const childProcess = spawn(pythonCommand, [...pythonBaseArgs, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        ...profileEnv, // Include active Claude profile config
        PYTHONUNBUFFERED: '1', // Ensure real-time output
        PYTHONIOENCODING: 'utf-8', // Ensure UTF-8 encoding on Windows
        PYTHONUTF8: '1' // Force Python UTF-8 mode on Windows (Python 3.7+)
      }
    });

    this.state.addProcess(taskId, {
      taskId,
      process: childProcess,
      startedAt: new Date(),
      spawnId
    });

    // Track execution progress
    let currentPhase: ExecutionProgressData['phase'] = isSpecRunner ? 'planning' : 'planning';
    let phaseProgress = 0;
    let currentSubtask: string | undefined;
    let lastMessage: string | undefined;
    // Collect all output for rate limit detection
    let allOutput = '';

    // Emit initial progress
    this.emitter.emit('execution-progress', taskId, {
      phase: currentPhase,
      phaseProgress: 0,
      overallProgress: this.events.calculateOverallProgress(currentPhase, 0),
      message: isSpecRunner ? 'Starting spec creation...' : 'Starting build process...'
    });

    const processLog = (log: string) => {
      // Collect output for rate limit detection (keep last 10KB)
      allOutput = (allOutput + log).slice(-10000);
      // Parse for phase transitions
      const phaseUpdate = this.events.parseExecutionPhase(log, currentPhase, isSpecRunner);

      if (phaseUpdate) {
        const phaseChanged = phaseUpdate.phase !== currentPhase;
        currentPhase = phaseUpdate.phase;

        if (phaseUpdate.currentSubtask) {
          currentSubtask = phaseUpdate.currentSubtask;
        }
        if (phaseUpdate.message) {
          lastMessage = phaseUpdate.message;
        }

        // Reset phase progress on phase change, otherwise increment
        if (phaseChanged) {
          phaseProgress = 10; // Start new phase at 10%
        } else {
          phaseProgress = Math.min(90, phaseProgress + 5); // Increment within phase
        }

        const overallProgress = this.events.calculateOverallProgress(currentPhase, phaseProgress);

        this.emitter.emit('execution-progress', taskId, {
          phase: currentPhase,
          phaseProgress,
          overallProgress,
          currentSubtask,
          message: lastMessage
        });
      }
    };

    // Handle stdout - explicitly decode as UTF-8 for cross-platform Unicode support
    childProcess.stdout?.on('data', (data: Buffer) => {
      const log = data.toString('utf8');
      this.emitter.emit('log', taskId, log);
      processLog(log);
      // Print to console when DEBUG is enabled (visible in pnpm dev terminal)
      if (['true', '1', 'yes', 'on'].includes(process.env.DEBUG?.toLowerCase() ?? '')) {
        console.log(`[Agent:${taskId}] ${log.trim()}`);
      }
    });

    // Handle stderr - explicitly decode as UTF-8 for cross-platform Unicode support
    childProcess.stderr?.on('data', (data: Buffer) => {
      const log = data.toString('utf8');
      // Some Python output goes to stderr (like progress bars)
      // so we treat it as log, not error
      this.emitter.emit('log', taskId, log);
      processLog(log);
      // Print to console when DEBUG is enabled (visible in pnpm dev terminal)
      if (['true', '1', 'yes', 'on'].includes(process.env.DEBUG?.toLowerCase() ?? '')) {
        console.log(`[Agent:${taskId}] ${log.trim()}`);
      }
    });

    // Handle process exit
    childProcess.on('exit', (code: number | null) => {
      this.state.deleteProcess(taskId);

      // Check if this specific spawn was killed (vs exited naturally)
      // If killed, don't emit exit event to prevent race condition with new process
      if (this.state.wasSpawnKilled(spawnId)) {
        this.state.clearKilledSpawn(spawnId);
        return;
      }

      // Check for rate limit if process failed
      if (code !== 0) {
        console.log('[AgentProcess] Process failed with code:', code, 'for task:', taskId);
        console.log('[AgentProcess] Checking for rate limit in output (last 500 chars):', allOutput.slice(-500));

        const rateLimitDetection = detectRateLimit(allOutput);
        console.log('[AgentProcess] Rate limit detection result:', {
          isRateLimited: rateLimitDetection.isRateLimited,
          resetTime: rateLimitDetection.resetTime,
          limitType: rateLimitDetection.limitType,
          profileId: rateLimitDetection.profileId,
          suggestedProfile: rateLimitDetection.suggestedProfile
        });

        if (rateLimitDetection.isRateLimited) {
          // Check if auto-swap is enabled
          const profileManager = getClaudeProfileManager();
          const autoSwitchSettings = profileManager.getAutoSwitchSettings();

          console.log('[AgentProcess] Auto-switch settings:', {
            enabled: autoSwitchSettings.enabled,
            autoSwitchOnRateLimit: autoSwitchSettings.autoSwitchOnRateLimit,
            proactiveSwapEnabled: autoSwitchSettings.proactiveSwapEnabled
          });

          if (autoSwitchSettings.enabled && autoSwitchSettings.autoSwitchOnRateLimit) {
            const currentProfileId = rateLimitDetection.profileId;
            const bestProfile = profileManager.getBestAvailableProfile(currentProfileId);

            console.log('[AgentProcess] Best available profile:', bestProfile ? {
              id: bestProfile.id,
              name: bestProfile.name
            } : 'NONE');

            if (bestProfile) {
              // Switch active profile
              console.log('[AgentProcess] AUTO-SWAP: Switching from', currentProfileId, 'to', bestProfile.id);
              profileManager.setActiveProfile(bestProfile.id);

              // Emit swap info (for modal)
              const source = processType === 'spec-creation' ? 'roadmap' : 'task';
              const rateLimitInfo = createSDKRateLimitInfo(source, rateLimitDetection, {
                taskId
              });
              rateLimitInfo.wasAutoSwapped = true;
              rateLimitInfo.swappedToProfile = {
                id: bestProfile.id,
                name: bestProfile.name
              };
              rateLimitInfo.swapReason = 'reactive';

              console.log('[AgentProcess] Emitting sdk-rate-limit event (auto-swapped):', rateLimitInfo);
              this.emitter.emit('sdk-rate-limit', rateLimitInfo);

              // Restart task
              console.log('[AgentProcess] Emitting auto-swap-restart-task event for task:', taskId);
              this.emitter.emit('auto-swap-restart-task', taskId, bestProfile.id);
              return;
            } else {
              console.log('[AgentProcess] No alternative profile available - falling back to manual modal');
            }
          } else {
            console.log('[AgentProcess] Auto-switch disabled - showing manual modal');
          }

          // Fall back to manual modal (no auto-swap or no alternative profile)
          const source = processType === 'spec-creation' ? 'roadmap' : 'task';
          const rateLimitInfo = createSDKRateLimitInfo(source, rateLimitDetection, {
            taskId
          });
          console.log('[AgentProcess] Emitting sdk-rate-limit event (manual):', rateLimitInfo);
          this.emitter.emit('sdk-rate-limit', rateLimitInfo);
        } else {
          console.log('[AgentProcess] No rate limit detected - checking for auth failure');
          // Not rate limited - check for authentication failure
          const authFailureDetection = detectAuthFailure(allOutput);
          if (authFailureDetection.isAuthFailure) {
            console.log('[AgentProcess] Auth failure detected:', authFailureDetection);
            this.emitter.emit('auth-failure', taskId, {
              profileId: authFailureDetection.profileId,
              failureType: authFailureDetection.failureType,
              message: authFailureDetection.message,
              originalError: authFailureDetection.originalError
            });
          } else {
            console.log('[AgentProcess] Process failed but no rate limit or auth failure detected');
          }
        }
      }

      // Emit final progress
      const finalPhase = code === 0 ? 'complete' : 'failed';
      this.emitter.emit('execution-progress', taskId, {
        phase: finalPhase,
        phaseProgress: 100,
        overallProgress: code === 0 ? 100 : this.events.calculateOverallProgress(currentPhase, phaseProgress),
        message: code === 0 ? 'Process completed successfully' : `Process exited with code ${code}`
      });

      this.emitter.emit('exit', taskId, code, processType);
    });

    // Handle process error
    childProcess.on('error', (err: Error) => {
      console.error('[AgentProcess] Process error:', err.message);
      this.state.deleteProcess(taskId);

      this.emitter.emit('execution-progress', taskId, {
        phase: 'failed',
        phaseProgress: 0,
        overallProgress: 0,
        message: `Error: ${err.message}`
      });

      this.emitter.emit('error', taskId, err.message);
    });
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
