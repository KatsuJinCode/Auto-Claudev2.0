/**
 * Agent module - modular agent management system
 *
 * This module provides a clean separation of concerns for agent process management:
 * - AgentManager: Main facade for orchestrating agent lifecycle
 * - AgentState: Process tracking and state management
 * - AgentEvents: Event handling and progress parsing
 * - AgentProcessManager: Process spawning and lifecycle
 * - AgentQueueManager: Ideation and roadmap queue management
 * - AgentRegistry: Persistent registry for detached agent processes
 * - FileOutputStreamer: Tail agent output files with cross-platform support
 */

export { AgentManager } from './agent-manager';
export { AgentState } from './agent-state';
export { AgentEvents } from './agent-events';
export { AgentProcessManager, killAgentProcess, forceKillAgentProcess, isProcessRunning } from './agent-process';
export { AgentQueueManager } from './agent-queue';
export {
  AgentRegistry,
  getAgentRegistry,
  resetAgentRegistry,
  getHeartbeatDir,
  getHeartbeatFilePath,
  readHeartbeat,
  writeHeartbeat,
  deleteHeartbeat
} from './agent-registry';
export { FileOutputStreamer, createFileOutputStreamer } from './file-output-streamer';

export type {
  DiscoveredAgent,
  DiscoveryResult,
  ReconnectionOptions,
  ReconnectResult,
  StopAgentOptions,
  StopAgentResult
} from './agent-manager';

export type {
  AgentProcess,
  ExecutionProgressData,
  ProcessType,
  AgentManagerEvents,
  TaskExecutionOptions,
  SpecCreationMetadata,
  IdeationProgressData,
  RoadmapProgressData
} from './types';

export type {
  AgentRegistryEntry,
  AgentStatus,
  HeartbeatData,
  HeartbeatReadResult,
  HeartbeatCheckStatus,
  HeartbeatCheckResult
} from './agent-registry';

export type {
  FileOutputStreamerOptions,
  FileOutputStreamerEvents
} from './file-output-streamer';

export type { KillAgentResult, ForceKillOptions, ForceKillAgentResult } from './agent-process';

// Re-export IdeationConfig from shared types for consistency
export type { IdeationConfig } from '../../shared/types';
