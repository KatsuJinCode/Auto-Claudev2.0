import { EventEmitter } from 'events';
import path from 'path';
import { existsSync } from 'fs';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { AgentProcessManager, killAgentProcess, forceKillAgentProcess } from './agent-process';
import { AgentQueueManager } from './agent-queue';
import { getAgentRegistry, AgentRegistryEntry } from './agent-registry';
import { FileOutputStreamer, createFileOutputStreamer } from './file-output-streamer';
import { getClaudeProfileManager } from '../claude-profile-manager';
import {
  SpecCreationMetadata,
  TaskExecutionOptions,
  RoadmapConfig
} from './types';
import type { IdeationConfig } from '../../shared/types';

/**
 * Result from discovering a running agent
 * Contains the registry entry plus validation details
 */
export interface DiscoveredAgent {
  /** The agent registry entry */
  entry: AgentRegistryEntry;
  /** Whether the agent was validated (PID alive and executionId matches) */
  validated: boolean;
  /** Reason for validation failure, if any */
  validationError?: string;
}

/**
 * Result from discovering all running agents
 */
export interface DiscoveryResult {
  /** Agents that are confirmed to be running (PID alive + executionId valid) */
  validAgents: AgentRegistryEntry[];
  /** Agents that failed validation (stale entries) */
  staleAgents: Array<{ entry: AgentRegistryEntry; reason: string }>;
  /** Total count of agents in registry before filtering */
  totalInRegistry: number;
}

/**
 * Options for reconnecting to a running agent
 */
export interface ReconnectionOptions {
  /** If true, start tailing from end of file (skip existing content). Defaults to true. */
  seekToEnd?: boolean;
  /** Custom task ID to use for events. If not provided, uses specId. */
  taskId?: string;
}

/**
 * Result from reconnecting to an agent
 */
export interface ReconnectResult {
  /** Whether reconnection was successful */
  success: boolean;
  /** Task ID used for event emissions */
  taskId: string;
  /** Error message if reconnection failed */
  error?: string;
}

/**
 * Options for stopping a running agent
 */
export interface StopAgentOptions {
  /**
   * Whether to force kill the agent if it doesn't respond to graceful shutdown.
   * If true, waits for gracefulTimeout then uses SIGKILL/taskkill.
   * Defaults to true.
   */
  forceIfNeeded?: boolean;
  /**
   * Timeout in milliseconds to wait for graceful shutdown before force kill.
   * Only used when forceIfNeeded is true.
   * Defaults to 5000 (5 seconds).
   */
  gracefulTimeout?: number;
}

/**
 * Result from stopping an agent
 */
export interface StopAgentResult {
  /** Whether the agent was successfully stopped */
  success: boolean;
  /** The task ID of the stopped agent */
  taskId: string;
  /** Method used to stop: 'graceful', 'force', 'already_stopped', 'not_found' */
  method: 'graceful' | 'force' | 'already_stopped' | 'not_found' | 'error';
  /** Error message if the stop failed */
  error?: string;
  /** Time in milliseconds it took to stop the agent */
  elapsedMs?: number;
}

/**
 * Internal tracking for reconnected agents
 */
interface ReconnectedAgent {
  /** The agent registry entry */
  entry: AgentRegistryEntry;
  /** Task ID used for events */
  taskId: string;
  /** FileOutputStreamer instance for tailing the output file */
  streamer: FileOutputStreamer;
  /** PID check interval */
  pidCheckInterval?: ReturnType<typeof setInterval>;
  /** Whether the agent has been marked as possibly crashed (to avoid repeated warnings) */
  markedAsPossiblyCrashed?: boolean;
}

/**
 * Main AgentManager - orchestrates agent process lifecycle
 * This is a slim facade that delegates to focused modules
 */
export class AgentManager extends EventEmitter {
  private state: AgentState;
  private events: AgentEvents;
  private processManager: AgentProcessManager;
  private queueManager: AgentQueueManager;
  private taskExecutionContext: Map<string, {
    projectPath: string;
    specId: string;
    options: TaskExecutionOptions;
    isSpecCreation?: boolean;
    taskDescription?: string;
    specDir?: string;
    metadata?: SpecCreationMetadata;
    swapCount: number;
  }> = new Map();
  /** Track reconnected agents for output file tailing */
  private reconnectedAgents: Map<string, ReconnectedAgent> = new Map();

  constructor() {
    super();

    // Initialize modular components
    this.state = new AgentState();
    this.events = new AgentEvents();
    this.processManager = new AgentProcessManager(this.state, this.events, this);
    this.queueManager = new AgentQueueManager(this.state, this.events, this.processManager, this);

    // Listen for auto-swap restart events
    this.on('auto-swap-restart-task', (taskId: string, newProfileId: string) => {
      console.log('[AgentManager] Received auto-swap-restart-task event:', { taskId, newProfileId });
      const success = this.restartTask(taskId, newProfileId);
      console.log('[AgentManager] Task restart result:', success ? 'SUCCESS' : 'FAILED');
    });

    // Listen for task completion to clean up context (prevent memory leak)
    this.on('exit', (taskId: string, code: number | null) => {
      // Clean up context when:
      // 1. Task completed successfully (code === 0), or
      // 2. Task failed and won't be restarted (handled by auto-swap logic)

      // Note: Auto-swap restart happens BEFORE this exit event is processed,
      // so we need a small delay to allow restart to preserve context
      setTimeout(() => {
        const context = this.taskExecutionContext.get(taskId);
        if (!context) return; // Already cleaned up or restarted

        // If task completed successfully, always clean up
        if (code === 0) {
          this.taskExecutionContext.delete(taskId);
          return;
        }

        // If task failed and hit max retries, clean up
        if (context.swapCount >= 2) {
          this.taskExecutionContext.delete(taskId);
        }
        // Otherwise keep context for potential restart
      }, 1000); // Delay to allow restart logic to run first
    });
  }

  /**
   * Configure paths for Python and auto-claude source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.processManager.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * Start spec creation process
   */
  startSpecCreation(
    taskId: string,
    projectPath: string,
    taskDescription: string,
    specDir?: string,
    metadata?: SpecCreationMetadata
  ): void {
    // Pre-flight auth check: Verify active profile has valid authentication
    const profileManager = getClaudeProfileManager();
    if (!profileManager.hasValidAuth()) {
      this.emit('error', taskId, 'Claude authentication required. Please authenticate in Settings > Claude Profiles before starting tasks.');
      return;
    }

    const autoBuildSource = this.processManager.getAutoBuildSourcePath();

    if (!autoBuildSource) {
      this.emit('error', taskId, 'Auto-build source path not found. Please configure it in App Settings.');
      return;
    }

    const specRunnerPath = path.join(autoBuildSource, 'runners', 'spec_runner.py');

    if (!existsSync(specRunnerPath)) {
      this.emit('error', taskId, `Spec runner not found at: ${specRunnerPath}`);
      return;
    }

    // Get combined environment variables
    const combinedEnv = this.processManager.getCombinedEnv(projectPath);

    // spec_runner.py will auto-start run.py after spec creation completes
    const args = [specRunnerPath, '--task', taskDescription, '--project-dir', projectPath];

    // Pass spec directory if provided (for UI-created tasks that already have a directory)
    if (specDir) {
      args.push('--spec-dir', specDir);
    }

    // Check if user requires review before coding
    if (!metadata?.requireReviewBeforeCoding) {
      // Auto-approve: When user starts a task from the UI without requiring review
      args.push('--auto-approve');
    }

    // Pass model and thinking level configuration
    // For auto profile, use phase-specific config; otherwise use single model/thinking
    if (metadata?.isAutoProfile && metadata.phaseModels && metadata.phaseThinking) {
      // Pass the spec phase model and thinking level to spec_runner
      args.push('--model', metadata.phaseModels.spec);
      args.push('--thinking-level', metadata.phaseThinking.spec);
    } else if (metadata?.model) {
      // Non-auto profile: use single model and thinking level
      args.push('--model', metadata.model);
      if (metadata.thinkingLevel) {
        args.push('--thinking-level', metadata.thinkingLevel);
      }
    }

    // Pass agent type if specified (to select AI backend: claude, gemini, opencode)
    if (metadata?.agentType) {
      args.push('--agent', metadata.agentType);
    }

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, '', {}, true, taskDescription, specDir, metadata);

    // Note: This is spec-creation but it chains to task-execution via run.py
    this.processManager.spawnProcess(taskId, autoBuildSource, args, combinedEnv, 'task-execution');
  }

  /**
   * Start task execution (run.py)
   */
  startTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions = {}
  ): void {
    // Pre-flight auth check: Verify active profile has valid authentication
    const profileManager = getClaudeProfileManager();
    if (!profileManager.hasValidAuth()) {
      this.emit('error', taskId, 'Claude authentication required. Please authenticate in Settings > Claude Profiles before starting tasks.');
      return;
    }

    const autoBuildSource = this.processManager.getAutoBuildSourcePath();

    if (!autoBuildSource) {
      this.emit('error', taskId, 'Auto-build source path not found. Please configure it in App Settings.');
      return;
    }

    const runPath = path.join(autoBuildSource, 'run.py');

    if (!existsSync(runPath)) {
      this.emit('error', taskId, `Run script not found at: ${runPath}`);
      return;
    }

    // Get combined environment variables
    const combinedEnv = this.processManager.getCombinedEnv(projectPath);

    const args = [runPath, '--spec', specId, '--project-dir', projectPath];

    // Always use auto-continue when running from UI (non-interactive)
    args.push('--auto-continue');

    // Force: When user starts a task from the UI, that IS their approval
    args.push('--force');

    // Pass base branch if specified (ensures worktrees are created from the correct branch)
    if (options.baseBranch) {
      args.push('--base-branch', options.baseBranch);
    }

    // Pass resume session ID if specified (to resume an interrupted Claude session)
    if (options.resumeSessionId) {
      args.push('--resume-session', options.resumeSessionId);
    }

    // Pass agent type if specified (to select AI backend: claude, gemini, opencode)
    if (options.agentType) {
      args.push('--agent', options.agentType);
    }

    // Note: --parallel was removed from run.py CLI - parallel execution is handled internally by the agent
    // The options.parallel and options.workers are kept for future use or logging purposes
    // Note: Model configuration is read from task_metadata.json by the Python scripts,
    // which allows per-phase configuration for planner, coder, and QA phases

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, specId, options, false);

    this.processManager.spawnProcess(taskId, autoBuildSource, args, combinedEnv, 'task-execution');
  }

  /**
   * Start QA process
   */
  startQAProcess(
    taskId: string,
    projectPath: string,
    specId: string
  ): void {
    const autoBuildSource = this.processManager.getAutoBuildSourcePath();

    if (!autoBuildSource) {
      this.emit('error', taskId, 'Auto-build source path not found. Please configure it in App Settings.');
      return;
    }

    const runPath = path.join(autoBuildSource, 'run.py');

    if (!existsSync(runPath)) {
      this.emit('error', taskId, `Run script not found at: ${runPath}`);
      return;
    }

    // Get combined environment variables
    const combinedEnv = this.processManager.getCombinedEnv(projectPath);

    const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--qa'];

    this.processManager.spawnProcess(taskId, autoBuildSource, args, combinedEnv, 'qa-process');
  }

  /**
   * Start roadmap generation process
   */
  startRoadmapGeneration(
    projectId: string,
    projectPath: string,
    refresh: boolean = false,
    enableCompetitorAnalysis: boolean = false,
    refreshCompetitorAnalysis: boolean = false,
    config?: RoadmapConfig
  ): void {
    this.queueManager.startRoadmapGeneration(projectId, projectPath, refresh, enableCompetitorAnalysis, refreshCompetitorAnalysis, config);
  }

  /**
   * Start ideation generation process
   */
  startIdeationGeneration(
    projectId: string,
    projectPath: string,
    config: IdeationConfig,
    refresh: boolean = false
  ): void {
    this.queueManager.startIdeationGeneration(projectId, projectPath, config, refresh);
  }

  /**
   * Kill a specific task's process
   */
  killTask(taskId: string): boolean {
    return this.processManager.killProcess(taskId);
  }

  /**
   * Stop ideation generation for a project
   */
  stopIdeation(projectId: string): boolean {
    return this.queueManager.stopIdeation(projectId);
  }

  /**
   * Check if ideation is running for a project
   */
  isIdeationRunning(projectId: string): boolean {
    return this.queueManager.isIdeationRunning(projectId);
  }

  /**
   * Stop roadmap generation for a project
   */
  stopRoadmap(projectId: string): boolean {
    return this.queueManager.stopRoadmap(projectId);
  }

  /**
   * Check if roadmap is running for a project
   */
  isRoadmapRunning(projectId: string): boolean {
    return this.queueManager.isRoadmapRunning(projectId);
  }

  /**
   * Kill all running processes
   */
  async killAll(): Promise<void> {
    await this.processManager.killAllProcesses();
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    return this.state.hasProcess(taskId);
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return this.state.getRunningTaskIds();
  }

  /**
   * Discover running agents from the registry and validate them
   *
   * This is the primary method for reconnecting to detached agents after GUI restart.
   * It reads all entries from the agent registry, validates each one by checking:
   * 1. PID is alive (process.kill(pid, 0) succeeds)
   * 2. ExecutionId in the registry matches the lockfile content
   *
   * The dual validation prevents false reconnections to recycled PIDs -
   * a new process at the same PID won't have our expected executionId in its lockfile.
   *
   * @returns DiscoveryResult with validated and stale agent lists
   */
  discoverRunningAgents(): DiscoveryResult {
    const registry = getAgentRegistry();

    // Load latest data from disk in case it changed while GUI was closed
    registry.load();

    // Get all agents marked as 'running' in the registry
    const runningAgents = registry.getRunningAgents();

    const validAgents: AgentRegistryEntry[] = [];
    const staleAgents: Array<{ entry: AgentRegistryEntry; reason: string }> = [];

    // Validate each registered agent
    for (const entry of runningAgents) {
      const validation = registry.isAgentAlive(entry.specId);

      if (validation.alive) {
        // Agent is confirmed running with valid executionId
        validAgents.push(entry);
      } else {
        // Agent failed validation - either process dead or executionId mismatch
        staleAgents.push({
          entry,
          reason: validation.reason || 'Unknown validation failure'
        });
      }
    }

    return {
      validAgents,
      staleAgents,
      totalInRegistry: runningAgents.length
    };
  }

  /**
   * Reconnect to a running detached agent and resume status updates
   *
   * This method enables the GUI to reconnect to agents that were running
   * when the GUI was closed/restarted. It:
   * 1. Validates the agent is still running (PID + executionId check)
   * 2. Starts tailing the output file using FileOutputStreamer
   * 3. Monitors the process to detect completion/failure
   * 4. Emits events to the renderer for UI updates
   *
   * @param entry - The agent registry entry (from discoverRunningAgents)
   * @param options - Reconnection options
   * @returns ReconnectResult indicating success/failure
   */
  reconnectToAgent(
    entry: AgentRegistryEntry,
    options: ReconnectionOptions = {}
  ): ReconnectResult {
    const { seekToEnd = true, taskId: customTaskId } = options;
    const taskId = customTaskId || entry.specId;

    // Check if already reconnected to this agent
    if (this.reconnectedAgents.has(taskId)) {
      return {
        success: false,
        taskId,
        error: `Already reconnected to agent with taskId '${taskId}'`
      };
    }

    // Validate the agent is still alive before reconnecting
    const registry = getAgentRegistry();
    const validation = registry.isAgentAlive(entry.specId);

    if (!validation.alive) {
      return {
        success: false,
        taskId,
        error: `Agent validation failed: ${validation.reason}`
      };
    }

    // Check if output file exists
    if (!entry.outputFile || !existsSync(entry.outputFile)) {
      return {
        success: false,
        taskId,
        error: `Output file not found: ${entry.outputFile || 'not specified'}`
      };
    }

    // Create FileOutputStreamer for tailing the output file
    const streamer = createFileOutputStreamer();

    // Wire up event handlers for the streamer
    streamer.on('line', (line: string) => {
      // Emit log events for each line
      this.emit('log', taskId, line + '\n');
      // Parse for progress updates
      this.parseOutputForProgress(taskId, line);
    });

    streamer.on('data', (chunk: string) => {
      // Raw data event can be used for debugging or alternative processing
      // Currently we rely on line events for cleaner output
    });

    streamer.on('error', (error: Error) => {
      // Log streamer errors but don't stop monitoring
      // Temporary errors (EBUSY, EAGAIN) are already handled by FileOutputStreamer
      console.warn(`[AgentManager] FileOutputStreamer error for ${taskId}: ${error.message}`);
    });

    // Handle seeked event - logs how much existing output was skipped
    // This is important for reconnection scenarios to verify we're not replaying old output
    streamer.on('seeked', (skippedBytes: number, totalFileSize: number) => {
      console.log(
        `[AgentManager] Reconnected to ${taskId}: skipped ${skippedBytes} bytes of existing output ` +
        `(file size: ${totalFileSize} bytes)`
      );
    });

    // Try to start the streamer
    try {
      streamer.start(entry.outputFile, {
        seekToEnd,
        watchMode: 'watchFile', // More reliable cross-platform
        pollInterval: 500 // Balance between responsiveness and CPU usage
      });
    } catch (error) {
      return {
        success: false,
        taskId,
        error: `Failed to start file streaming: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    // Create tracking entry
    const reconnectedAgent: ReconnectedAgent = {
      entry,
      taskId,
      streamer
    };

    this.reconnectedAgents.set(taskId, reconnectedAgent);

    // Emit initial status - agent is reconnected and running
    this.emit('execution-progress', taskId, {
      phase: 'coding', // Assume coding phase for reconnected agents
      phaseProgress: 50, // Unknown progress, show middle
      overallProgress: 50,
      message: 'Reconnected to running agent'
    });

    // Start PID monitoring to detect when process exits
    this.startPidMonitoring(reconnectedAgent);

    return {
      success: true,
      taskId
    };
  }

  /**
   * Disconnect from a reconnected agent (stop tailing output)
   *
   * This stops monitoring the agent but does NOT kill the process.
   * Use this when the GUI is closing or the user navigates away.
   *
   * @param taskId - The task ID of the reconnected agent
   * @returns true if agent was found and disconnected
   */
  disconnectFromAgent(taskId: string): boolean {
    const agent = this.reconnectedAgents.get(taskId);
    if (!agent) {
      return false;
    }

    // Stop file streaming using FileOutputStreamer
    if (agent.streamer.getIsActive()) {
      agent.streamer.stop();
    }

    // Stop PID monitoring
    if (agent.pidCheckInterval) {
      clearInterval(agent.pidCheckInterval);
      agent.pidCheckInterval = undefined;
    }

    this.reconnectedAgents.delete(taskId);
    return true;
  }

  /**
   * Check if an agent is reconnected (being monitored)
   */
  isReconnected(taskId: string): boolean {
    return this.reconnectedAgents.has(taskId);
  }

  /**
   * Get all reconnected agent task IDs
   */
  getReconnectedTasks(): string[] {
    return Array.from(this.reconnectedAgents.keys());
  }

  /**
   * Disconnect from all reconnected agents without killing their processes
   *
   * This is called during graceful GUI shutdown to stop monitoring agents
   * while allowing them to continue running in the background. The agents
   * remain registered and can be reconnected to when the GUI restarts.
   *
   * This is different from killAll() which terminates all processes.
   *
   * @returns Number of agents disconnected
   */
  disconnectAll(): number {
    const taskIds = this.getReconnectedTasks();
    let disconnectedCount = 0;

    for (const taskId of taskIds) {
      if (this.disconnectFromAgent(taskId)) {
        disconnectedCount++;
      }
    }

    return disconnectedCount;
  }

  /**
   * Stop a running detached agent with graceful shutdown
   *
   * This method is the explicit "Stop" button behavior for detached agents.
   * It sends a graceful shutdown signal (SIGTERM on Unix, SIGBREAK/CTRL_BREAK_EVENT on Windows)
   * and optionally force kills if the process doesn't respond within the timeout.
   *
   * The method:
   * 1. Validates the agent is being monitored (reconnected)
   * 2. Sends graceful shutdown signal via killAgentProcess()
   * 3. Optionally waits and force kills via forceKillAgentProcess() if needed
   * 4. Disconnects from the agent (stops output file tailing)
   * 5. Updates registry status (handled by PID monitoring or explicit cleanup)
   *
   * Note: Registry cleanup and lockfile deletion are handled by subtask 6.3.
   * This method focuses on the stop signal and monitoring cleanup.
   *
   * @param taskId - The task ID of the agent to stop (must be reconnected)
   * @param options - Options for the stop operation
   * @returns Promise resolving to StopAgentResult
   *
   * @example
   * // Graceful stop with default 5 second timeout then force kill
   * const result = await agentManager.stopAgent('my-task');
   *
   * @example
   * // Graceful stop only (no force kill)
   * const result = await agentManager.stopAgent('my-task', { forceIfNeeded: false });
   *
   * @example
   * // Quick force kill after 2 seconds
   * const result = await agentManager.stopAgent('my-task', { gracefulTimeout: 2000 });
   */
  async stopAgent(taskId: string, options: StopAgentOptions = {}): Promise<StopAgentResult> {
    const { forceIfNeeded = true, gracefulTimeout = 5000 } = options;
    const startTime = Date.now();

    // Check if this is a reconnected agent we're monitoring
    const reconnectedAgent = this.reconnectedAgents.get(taskId);
    if (!reconnectedAgent) {
      // Check if it's a locally spawned task (handled by killTask)
      if (this.state.hasProcess(taskId)) {
        // Delegate to existing killTask method for locally spawned processes
        const killed = this.killTask(taskId);
        return {
          success: killed,
          taskId,
          method: killed ? 'graceful' : 'error',
          error: killed ? undefined : 'Failed to kill locally spawned process',
          elapsedMs: Date.now() - startTime
        };
      }

      return {
        success: false,
        taskId,
        method: 'not_found',
        error: `Agent with taskId '${taskId}' is not being monitored. ` +
               'Use reconnectToAgent() first or verify the taskId is correct.',
        elapsedMs: Date.now() - startTime
      };
    }

    const { entry } = reconnectedAgent;
    const pid = entry.pid;

    // Validate the agent is still alive
    const registry = getAgentRegistry();
    const validation = registry.isAgentAlive(entry.specId);

    if (!validation.alive) {
      // Agent is already dead - clean up monitoring and registry
      this.cleanupAgentOnExit(entry.specId);
      this.disconnectFromAgent(taskId);
      return {
        success: true,
        taskId,
        method: 'already_stopped',
        elapsedMs: Date.now() - startTime
      };
    }

    // Send graceful shutdown signal
    const gracefulResult = killAgentProcess(pid);

    if (!gracefulResult.success) {
      // Failed to send signal - this is an error condition
      // Still disconnect from monitoring (but don't clean up registry as process state is unknown)
      this.disconnectFromAgent(taskId);
      return {
        success: false,
        taskId,
        method: 'error',
        error: gracefulResult.error || 'Failed to send graceful shutdown signal',
        elapsedMs: Date.now() - startTime
      };
    }

    // If the process was already terminated (ESRCH), we're done
    if (gracefulResult.terminated) {
      // Clean up registry entry and lockfile since process is confirmed dead
      this.cleanupAgentOnExit(entry.specId);
      this.disconnectFromAgent(taskId);
      return {
        success: true,
        taskId,
        method: 'already_stopped',
        elapsedMs: Date.now() - startTime
      };
    }

    // Wait for graceful shutdown if force kill is enabled
    if (forceIfNeeded) {
      // Wait for process to exit gracefully within timeout
      const waitStartTime = Date.now();
      let processExited = false;

      while (Date.now() - waitStartTime < gracefulTimeout) {
        const stillAlive = registry.isAgentAlive(entry.specId);
        if (!stillAlive.alive) {
          processExited = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!processExited) {
        // Process didn't exit gracefully, force kill it
        const forceResult = await forceKillAgentProcess(pid, {
          gracefulFirst: false // Skip graceful since we already tried
        });

        // Clean up registry entry and lockfile if force kill succeeded
        if (forceResult.success) {
          this.cleanupAgentOnExit(entry.specId);
        }
        this.disconnectFromAgent(taskId);

        return {
          success: forceResult.success,
          taskId,
          method: 'force',
          error: forceResult.error,
          elapsedMs: Date.now() - startTime
        };
      }

      // Process exited gracefully - clean up registry entry and lockfile
      this.cleanupAgentOnExit(entry.specId);
      this.disconnectFromAgent(taskId);
      return {
        success: true,
        taskId,
        method: 'graceful',
        elapsedMs: Date.now() - startTime
      };
    }

    // No force kill requested - just disconnect after sending graceful signal
    // The agent may or may not stop (we won't wait to find out)
    this.disconnectFromAgent(taskId);

    return {
      success: true,
      taskId,
      method: 'graceful',
      elapsedMs: Date.now() - startTime
    };
  }

  /**
   * Stop a running detached agent by specId (convenience method)
   *
   * This is a convenience wrapper around stopAgent() that looks up the agent
   * by specId and stops it. Useful when you have the specId but not the taskId.
   *
   * @param specId - The spec ID of the agent to stop
   * @param options - Options for the stop operation
   * @returns Promise resolving to StopAgentResult
   */
  async stopAgentBySpecId(specId: string, options: StopAgentOptions = {}): Promise<StopAgentResult> {
    // Find the reconnected agent with this specId
    for (const [taskId, agent] of this.reconnectedAgents) {
      if (agent.entry.specId === specId) {
        return this.stopAgent(taskId, options);
      }
    }

    // Check if there's a registry entry for this specId even if not reconnected
    const registry = getAgentRegistry();
    const entry = registry.get(specId);

    if (!entry) {
      return {
        success: false,
        taskId: specId,
        method: 'not_found',
        error: `No agent found with specId '${specId}'`
      };
    }

    // Agent exists in registry but not reconnected - try to kill by PID directly
    const validation = registry.isAgentAlive(specId);

    if (!validation.alive) {
      // Agent is already dead - clean up registry entry and lockfile
      this.cleanupAgentOnExit(specId);
      return {
        success: true,
        taskId: specId,
        method: 'already_stopped'
      };
    }

    // Kill by PID directly
    const { forceIfNeeded = true, gracefulTimeout = 5000 } = options;
    const startTime = Date.now();

    const gracefulResult = killAgentProcess(entry.pid);

    if (gracefulResult.terminated) {
      // Process was already terminated - clean up registry entry and lockfile
      this.cleanupAgentOnExit(specId);
      return {
        success: true,
        taskId: specId,
        method: 'already_stopped',
        elapsedMs: Date.now() - startTime
      };
    }

    if (forceIfNeeded && gracefulResult.success) {
      const forceResult = await forceKillAgentProcess(entry.pid, {
        gracefulFirst: false, // Already sent graceful signal
        gracefulTimeout
      });

      // Clean up registry entry and lockfile if force kill succeeded
      if (forceResult.success) {
        this.cleanupAgentOnExit(specId);
      }

      return {
        success: forceResult.success,
        taskId: specId,
        method: forceResult.method === 'graceful' ? 'graceful' : 'force',
        error: forceResult.error,
        elapsedMs: Date.now() - startTime
      };
    }

    // Graceful signal sent without force kill - don't clean up yet
    // The registry entry will be cleaned up on next discovery if process exits
    return {
      success: gracefulResult.success,
      taskId: specId,
      method: 'graceful',
      error: gracefulResult.error,
      elapsedMs: Date.now() - startTime
    };
  }

  /**
   * Clean up an agent when its process exits
   *
   * This method handles the final cleanup when an agent process terminates:
   * 1. Unregisters the agent from the registry (removes the entry)
   * 2. Deletes the associated lockfile
   *
   * This is called from:
   * - startPidMonitoring() when it detects the process has exited
   * - stopAgent() after successfully stopping an agent
   * - stopAgentBySpecId() after successfully stopping an agent by specId
   *
   * Note: This uses cleanupStaleEntry() from the registry which handles
   * both removal and lockfile deletion atomically.
   *
   * @param specId - The spec ID of the agent to clean up
   * @returns Object with cleanup result details
   */
  private cleanupAgentOnExit(specId: string): { success: boolean; lockfileDeleted: boolean; error?: string } {
    const registry = getAgentRegistry();

    // Use the registry's cleanupStaleEntry which handles both
    // registry removal and lockfile deletion
    const result = registry.cleanupStaleEntry(specId);

    if (result.success) {
      console.log(
        `[AgentManager] Cleaned up agent '${specId}': ` +
        `registry entry removed, lockfile ${result.lockfileDeleted ? 'deleted' : 'not found/already deleted'}`
      );
    } else {
      console.warn(
        `[AgentManager] Failed to clean up agent '${specId}': ${result.error}`
      );
    }

    return result;
  }

  /**
   * Parse output content for progress information
   * This mirrors the logic in AgentProcessManager.spawnProcess
   */
  private parseOutputForProgress(taskId: string, content: string): void {
    // Parse for phase transitions using the events helper
    const phaseUpdate = this.events.parseExecutionPhase(content, 'coding', false);

    if (phaseUpdate) {
      this.emit('execution-progress', taskId, {
        phase: phaseUpdate.phase,
        phaseProgress: 50, // Unknown exact progress
        overallProgress: this.events.calculateOverallProgress(phaseUpdate.phase, 50),
        currentSubtask: phaseUpdate.currentSubtask,
        message: phaseUpdate.message
      });
    }
  }

  /**
   * Start monitoring the agent's PID to detect when it exits
   *
   * When the process exits, this method:
   * 1. Triggers a final read to capture remaining output
   * 2. Emits exit events to update the UI
   * 3. Cleans up by unregistering from registry and deleting lockfile
   * 4. Disconnects from the agent (stops file tailing)
   *
   * Additionally, this method checks the heartbeat to detect hung/crashed agents:
   * - If PID is alive but heartbeat is stale (> 60 seconds old), marks agent as 'possibly_crashed'
   * - Emits a warning event to the GUI so the user can see the agent may be hung
   * - This provides a secondary health check beyond simple PID monitoring
   */
  private startPidMonitoring(agent: ReconnectedAgent): void {
    const { entry, taskId, streamer } = agent;
    const registry = getAgentRegistry();

    // Check PID every 2 seconds
    agent.pidCheckInterval = setInterval(() => {
      const validation = registry.isAgentAlive(entry.specId);

      if (!validation.alive) {
        // Agent has exited - trigger a final read to capture any remaining output
        // FileOutputStreamer.triggerRead() forces an immediate read of new content
        streamer.triggerRead();

        // Determine exit status based on validation reason
        const isCompleted = validation.reason?.includes('not running') ?? false;

        // Emit exit event to update UI
        this.emit('execution-progress', taskId, {
          phase: isCompleted ? 'complete' : 'failed',
          phaseProgress: 100,
          overallProgress: isCompleted ? 100 : 50,
          message: isCompleted ? 'Agent completed' : `Agent stopped: ${validation.reason}`
        });

        this.emit('exit', taskId, isCompleted ? 0 : 1, 'task-execution');

        // Clean up: unregister from registry and delete lockfile
        // This ensures the registry accurately reflects running vs stopped agents
        this.cleanupAgentOnExit(entry.specId);

        // Clean up monitoring (this also stops the streamer)
        this.disconnectFromAgent(taskId);
      } else {
        // Process is alive - check heartbeat to detect hung/crashed agents
        // This provides a secondary health check: a process can be alive but unresponsive
        this.checkAndUpdateHeartbeatStatus(agent);
      }
    }, 2000);
  }

  /**
   * Check the heartbeat status of a reconnected agent and update status if stale
   *
   * This method detects the case where:
   * - PID is alive (process exists)
   * - But heartbeat is stale (agent hasn't updated heartbeat in > 60 seconds)
   *
   * This typically indicates the agent is hung, crashed internally, or stuck.
   * The GUI should show a warning to the user so they can decide to force stop.
   *
   * @param agent - The reconnected agent to check
   */
  private checkAndUpdateHeartbeatStatus(agent: ReconnectedAgent): void {
    const { entry, taskId } = agent;
    const registry = getAgentRegistry();

    // Check heartbeat status
    const heartbeatResult = registry.checkHeartbeat(entry.specId);

    if (heartbeatResult.status === 'stale') {
      // Heartbeat is stale - agent may be hung or crashed
      // Only emit warning once to avoid spamming the UI
      if (!agent.markedAsPossiblyCrashed) {
        agent.markedAsPossiblyCrashed = true;

        // Update registry status to 'possibly_crashed'
        const currentEntry = registry.get(entry.specId);
        if (currentEntry && currentEntry.status !== 'possibly_crashed') {
          registry.updatePartial(entry.specId, { status: 'possibly_crashed' });
          registry.save();
        }

        // Emit warning event to the GUI
        const ageSeconds = heartbeatResult.ageMs
          ? Math.round(heartbeatResult.ageMs / 1000)
          : 'unknown';

        this.emit('execution-progress', taskId, {
          phase: 'coding', // Keep showing as coding phase but with warning
          phaseProgress: 50,
          overallProgress: 50,
          message: `⚠️ Agent may be hung (no heartbeat for ${ageSeconds}s)`,
          warning: true // Custom flag to indicate this is a warning state
        });

        console.warn(
          `[AgentManager] Agent '${entry.specId}' may be hung or crashed: ` +
          `PID ${entry.pid} is alive but heartbeat is ${ageSeconds}s old. ` +
          `User may need to force stop this agent.`
        );
      }
    } else if (heartbeatResult.status === 'healthy' && agent.markedAsPossiblyCrashed) {
      // Heartbeat recovered - agent is responsive again
      agent.markedAsPossiblyCrashed = false;

      // Update registry status back to 'running'
      const currentEntry = registry.get(entry.specId);
      if (currentEntry && currentEntry.status === 'possibly_crashed') {
        registry.updatePartial(entry.specId, { status: 'running' });
        registry.save();
      }

      // Emit update to clear the warning
      this.emit('execution-progress', taskId, {
        phase: 'coding',
        phaseProgress: 50,
        overallProgress: 50,
        message: 'Agent resumed activity'
      });

      console.log(
        `[AgentManager] Agent '${entry.specId}' heartbeat recovered. ` +
        `Status changed from 'possibly_crashed' back to 'running'.`
      );
    }
    // For 'missing' or 'error' status, we don't mark as crashed
    // because the agent may not have started writing heartbeats yet
    // or there was a temporary file access issue
  }

  /**
   * Store task execution context for potential restarts
   */
  private storeTaskContext(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions,
    isSpecCreation?: boolean,
    taskDescription?: string,
    specDir?: string,
    metadata?: SpecCreationMetadata
  ): void {
    // Preserve swapCount if context already exists (for restarts)
    const existingContext = this.taskExecutionContext.get(taskId);
    const swapCount = existingContext?.swapCount ?? 0;

    this.taskExecutionContext.set(taskId, {
      projectPath,
      specId,
      options,
      isSpecCreation,
      taskDescription,
      specDir,
      metadata,
      swapCount // Preserve existing count instead of resetting
    });
  }

  /**
   * Restart task after profile swap
   * @param taskId - The task to restart
   * @param newProfileId - Optional new profile ID to apply (from auto-swap)
   */
  restartTask(taskId: string, newProfileId?: string): boolean {
    console.log('[AgentManager] restartTask called for:', taskId, 'with newProfileId:', newProfileId);

    const context = this.taskExecutionContext.get(taskId);
    if (!context) {
      console.error('[AgentManager] No context for task:', taskId);
      console.log('[AgentManager] Available task contexts:', Array.from(this.taskExecutionContext.keys()));
      return false;
    }

    console.log('[AgentManager] Task context found:', {
      taskId,
      projectPath: context.projectPath,
      specId: context.specId,
      isSpecCreation: context.isSpecCreation,
      swapCount: context.swapCount
    });

    // Prevent infinite swap loops
    if (context.swapCount >= 2) {
      console.error('[AgentManager] Max swap count reached for task:', taskId, '- stopping restart loop');
      return false;
    }

    context.swapCount++;
    console.log('[AgentManager] Incremented swap count to:', context.swapCount);

    // If a new profile was specified, ensure it's set as active before restart
    if (newProfileId) {
      const profileManager = getClaudeProfileManager();
      const currentActiveId = profileManager.getActiveProfile()?.id;
      if (currentActiveId !== newProfileId) {
        console.log('[AgentManager] Setting active profile to:', newProfileId);
        profileManager.setActiveProfile(newProfileId);
      }
    }

    // Kill current process
    console.log('[AgentManager] Killing current process for task:', taskId);
    this.killTask(taskId);

    // Wait for cleanup, then restart
    console.log('[AgentManager] Scheduling task restart in 500ms');
    setTimeout(() => {
      console.log('[AgentManager] Restarting task now:', taskId);
      if (context.isSpecCreation) {
        console.log('[AgentManager] Restarting as spec creation');
        this.startSpecCreation(
          taskId,
          context.projectPath,
          context.taskDescription!,
          context.specDir,
          context.metadata
        );
      } else {
        console.log('[AgentManager] Restarting as task execution');
        this.startTaskExecution(
          taskId,
          context.projectPath,
          context.specId,
          context.options
        );
      }
    }, 500);

    return true;
  }
}
