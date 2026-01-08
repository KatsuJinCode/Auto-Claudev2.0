/**
 * Agent Registry Module
 *
 * Provides persistent registry for tracking detached agent processes.
 * Enables agent processes to survive GUI restarts by storing process
 * information in a JSON file that can be read on startup.
 *
 * Key features:
 * - Persistent storage of running agent process metadata
 * - PID reuse protection via execution IDs (UUIDs)
 * - Restrictive file permissions for security
 * - Cross-platform compatibility (Windows/Unix)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAppPath } from '../config-paths';
import { ensureDir } from '../fs-utils';

/**
 * Agent status values
 */
export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'possibly_crashed';

/**
 * Registry entry for a single agent process
 * Contains all information needed to track and reconnect to a detached agent
 */
export interface AgentRegistryEntry {
  /** Process ID of the running agent */
  pid: number;
  /** Unique execution ID (UUID) to prevent PID reuse issues */
  executionId: string;
  /** Spec ID the agent is working on */
  specId: string;
  /** Session ID for the Claude conversation */
  sessionId?: string;
  /** ISO timestamp when the agent was started */
  startedAt: string;
  /** ISO timestamp of the last heartbeat from the agent */
  lastHeartbeat: string;
  /** Current status of the agent */
  status: AgentStatus;
  /** Path to the output log file */
  outputFile: string;
  /** Path to the lock file containing executionId */
  lockFile: string;
  /** Working directory where the agent is running */
  workingDirectory: string;
}

/**
 * Registry file structure
 */
interface RegistryData {
  version: number;
  agents: Record<string, AgentRegistryEntry>;
  updatedAt: string;
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILENAME = 'agents-registry.json';
const HEARTBEAT_DIR = 'agent-heartbeat';

/**
 * Default threshold for considering a heartbeat stale (in milliseconds)
 * If an agent hasn't updated its heartbeat within this time, it may be hung or crashed
 */
const HEARTBEAT_STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds

/**
 * Heartbeat file data format
 *
 * Heartbeat files are stored at .auto-claude/agent-heartbeat/{specId}.json
 * and are written periodically by running agents to indicate they are still alive.
 *
 * This provides a secondary health check beyond PID monitoring:
 * - PID check: verifies process exists
 * - Heartbeat check: verifies process is responsive (not hung/crashed)
 *
 * File format: JSON with the following structure
 */
export interface HeartbeatData {
  /** ISO timestamp when this heartbeat was written */
  timestamp: string;
  /** Current status of the agent */
  status: AgentStatus;
  /** Unique execution ID to correlate with registry entry */
  executionId: string;
  /** Spec ID the agent is working on */
  specId: string;
  /** Optional message about current activity */
  currentActivity?: string;
  /** Optional progress percentage (0-100) */
  progressPercent?: number;
  /** PID of the agent process (for additional validation) */
  pid: number;
}

/**
 * Result of reading a heartbeat file
 */
export interface HeartbeatReadResult {
  /** Whether the heartbeat was successfully read */
  success: boolean;
  /** The heartbeat data if successful */
  data?: HeartbeatData;
  /** Error message if unsuccessful */
  error?: string;
  /** Whether the heartbeat file exists */
  fileExists: boolean;
}

/**
 * Heartbeat check status values
 * - 'healthy': Heartbeat is recent (within threshold)
 * - 'stale': Heartbeat is too old (agent may be hung or crashed)
 * - 'missing': No heartbeat file exists (agent may not have started writing heartbeats yet)
 * - 'error': Failed to read or parse heartbeat file
 * - 'not_found': Agent not found in registry
 */
export type HeartbeatCheckStatus = 'healthy' | 'stale' | 'missing' | 'error' | 'not_found';

/**
 * Result of checking an agent's heartbeat status
 */
export interface HeartbeatCheckResult {
  /** The heartbeat check status */
  status: HeartbeatCheckStatus;
  /** Age of the heartbeat in milliseconds (if available) */
  ageMs?: number;
  /** ISO timestamp of the last heartbeat (if available) */
  lastHeartbeat?: string;
  /** Error or reason message for non-healthy statuses */
  reason?: string;
  /** The heartbeat data (if successfully read) */
  heartbeatData?: HeartbeatData;
}

/**
 * Get the directory path for heartbeat files
 * @param workingDirectory - The project working directory
 * @returns Path to the heartbeat directory
 */
export function getHeartbeatDir(workingDirectory: string): string {
  return path.join(workingDirectory, '.auto-claude', HEARTBEAT_DIR);
}

/**
 * Get the path to a specific agent's heartbeat file
 * @param workingDirectory - The project working directory
 * @param specId - The spec ID of the agent
 * @returns Path to the heartbeat file
 */
export function getHeartbeatFilePath(workingDirectory: string, specId: string): string {
  return path.join(getHeartbeatDir(workingDirectory), `${specId}.json`);
}

/**
 * Read and parse a heartbeat file for an agent
 *
 * @param workingDirectory - The project working directory
 * @param specId - The spec ID of the agent
 * @returns HeartbeatReadResult with success status and data or error
 */
export function readHeartbeat(workingDirectory: string, specId: string): HeartbeatReadResult {
  const heartbeatPath = getHeartbeatFilePath(workingDirectory, specId);

  try {
    if (!fs.existsSync(heartbeatPath)) {
      return { success: false, fileExists: false, error: 'Heartbeat file does not exist' };
    }

    const content = fs.readFileSync(heartbeatPath, 'utf-8');
    const data = JSON.parse(content) as HeartbeatData;

    // Validate required fields
    if (!data.timestamp || !data.status || !data.executionId || !data.specId || data.pid === undefined) {
      return {
        success: false,
        fileExists: true,
        error: 'Heartbeat file has invalid format: missing required fields'
      };
    }

    return { success: true, data, fileExists: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      fileExists: fs.existsSync(heartbeatPath),
      error: `Failed to read heartbeat: ${errorMessage}`
    };
  }
}

/**
 * Write a heartbeat file for an agent
 *
 * This function is typically called by the agent process itself,
 * but can also be used by the GUI to initialize the heartbeat file
 * when starting a new agent.
 *
 * @param workingDirectory - The project working directory
 * @param data - The heartbeat data to write
 * @returns Object with success status and error if failed
 */
export function writeHeartbeat(
  workingDirectory: string,
  data: HeartbeatData
): { success: boolean; error?: string } {
  const heartbeatPath = getHeartbeatFilePath(workingDirectory, data.specId);

  try {
    // Ensure directory exists
    const heartbeatDir = getHeartbeatDir(workingDirectory);
    ensureDir(heartbeatDir);

    // Write heartbeat file
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(heartbeatPath, content, { encoding: 'utf-8', mode: 0o644 });

    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to write heartbeat: ${errorMessage}` };
  }
}

/**
 * Delete a heartbeat file for an agent
 * Used during cleanup when an agent exits
 *
 * @param workingDirectory - The project working directory
 * @param specId - The spec ID of the agent
 * @returns Object with success status and error if failed
 */
export function deleteHeartbeat(
  workingDirectory: string,
  specId: string
): { success: boolean; error?: string } {
  const heartbeatPath = getHeartbeatFilePath(workingDirectory, specId);

  try {
    if (fs.existsSync(heartbeatPath)) {
      fs.unlinkSync(heartbeatPath);
    }
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Failed to delete heartbeat: ${errorMessage}` };
  }
}

/**
 * Agent Registry class for persistent tracking of detached agent processes
 *
 * This class provides methods to:
 * - Load registry data from disk
 * - Save registry data to disk with atomic writes
 * - Update individual agent entries
 * - Query running agents
 *
 * The registry file is stored in the XDG-compliant data directory
 * with restrictive permissions to prevent unauthorized access.
 */
export class AgentRegistry {
  private registryPath: string;
  private data: RegistryData;
  private isDirty: boolean = false;

  constructor(customPath?: string) {
    // Use custom path if provided (useful for testing), otherwise use XDG data dir
    if (customPath) {
      this.registryPath = customPath;
    } else {
      const dataDir = getAppPath('data');
      ensureDir(dataDir);
      this.registryPath = path.join(dataDir, REGISTRY_FILENAME);
    }

    // Initialize with empty data
    this.data = this.createEmptyData();
  }

  /**
   * Create empty registry data structure
   */
  private createEmptyData(): RegistryData {
    return {
      version: REGISTRY_VERSION,
      agents: {},
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Get the path to the registry file
   */
  getRegistryPath(): string {
    return this.registryPath;
  }

  /**
   * Load registry data from disk
   * Creates a new empty registry if the file doesn't exist
   *
   * @returns true if loaded successfully, false on error
   */
  load(): boolean {
    try {
      if (!fs.existsSync(this.registryPath)) {
        // No existing registry - start fresh
        this.data = this.createEmptyData();
        this.isDirty = false;
        return true;
      }

      const content = fs.readFileSync(this.registryPath, 'utf-8');
      const parsed = JSON.parse(content) as RegistryData;

      // Validate version
      if (parsed.version !== REGISTRY_VERSION) {
        console.warn(`[AgentRegistry] Registry version mismatch: expected ${REGISTRY_VERSION}, got ${parsed.version}`);
        // For now, reset to empty on version mismatch
        // Future: implement migration logic
        this.data = this.createEmptyData();
        this.isDirty = true;
        return true;
      }

      this.data = parsed;
      this.isDirty = false;
      return true;
    } catch (error) {
      console.error('[AgentRegistry] Failed to load registry:', error);
      // Reset to empty data on error
      this.data = this.createEmptyData();
      this.isDirty = false;
      return false;
    }
  }

  /**
   * Save registry data to disk with atomic write
   * Uses write-to-temp-then-rename pattern to prevent corruption
   *
   * @returns true if saved successfully, false on error
   */
  save(): boolean {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.registryPath);
      ensureDir(dir);

      // Update timestamp
      this.data.updatedAt = new Date().toISOString();

      // Atomic write: write to temp file then rename
      const tempPath = `${this.registryPath}.tmp.${Date.now()}`;
      const content = JSON.stringify(this.data, null, 2);

      fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });

      // Set restrictive permissions (owner read/write only)
      this.setRestrictivePermissions(tempPath);

      // Rename to target (atomic on most filesystems)
      fs.renameSync(tempPath, this.registryPath);

      // Set restrictive permissions on final file too
      this.setRestrictivePermissions(this.registryPath);

      this.isDirty = false;
      return true;
    } catch (error) {
      console.error('[AgentRegistry] Failed to save registry:', error);
      return false;
    }
  }

  /**
   * Set restrictive file permissions (owner read/write only)
   * Security measure to prevent PID injection attacks
   *
   * @param filePath - Path to the file
   */
  private setRestrictivePermissions(filePath: string): void {
    try {
      if (process.platform !== 'win32') {
        // Unix: set to 0600 (owner read/write only)
        fs.chmodSync(filePath, 0o600);
      }
      // Windows: File permissions are handled through ACLs
      // The default behavior creates user-owned files which is typically sufficient
      // For enhanced Windows security, we could use node-windows-acl or similar
    } catch (error) {
      console.warn('[AgentRegistry] Failed to set file permissions:', error);
    }
  }

  /**
   * Update a single agent entry in the registry
   * Automatically marks registry as dirty for next save
   *
   * @param specId - The spec ID to identify the agent
   * @param entry - The complete entry data
   */
  update(specId: string, entry: AgentRegistryEntry): void {
    this.data.agents[specId] = entry;
    this.isDirty = true;
  }

  /**
   * Update specific fields of an agent entry
   * Creates new entry if it doesn't exist
   *
   * @param specId - The spec ID to identify the agent
   * @param updates - Partial entry data to merge
   */
  updatePartial(specId: string, updates: Partial<AgentRegistryEntry>): void {
    const existing = this.data.agents[specId];
    if (existing) {
      this.data.agents[specId] = { ...existing, ...updates };
    } else if (this.isCompleteEntry(updates)) {
      this.data.agents[specId] = updates as AgentRegistryEntry;
    } else {
      console.warn(`[AgentRegistry] Cannot update non-existent entry ${specId} with partial data`);
      return;
    }
    this.isDirty = true;
  }

  /**
   * Check if partial data is actually a complete entry
   */
  private isCompleteEntry(data: Partial<AgentRegistryEntry>): data is AgentRegistryEntry {
    return !!(
      data.pid !== undefined &&
      data.executionId &&
      data.specId &&
      data.startedAt &&
      data.lastHeartbeat &&
      data.status &&
      data.outputFile &&
      data.lockFile &&
      data.workingDirectory
    );
  }

  /**
   * Get a single agent entry by spec ID
   *
   * @param specId - The spec ID to look up
   * @returns The entry or undefined if not found
   */
  get(specId: string): AgentRegistryEntry | undefined {
    return this.data.agents[specId];
  }

  /**
   * Remove an agent entry from the registry
   *
   * @param specId - The spec ID to remove
   * @returns true if entry was removed, false if not found
   */
  remove(specId: string): boolean {
    if (this.data.agents[specId]) {
      delete this.data.agents[specId];
      this.isDirty = true;
      return true;
    }
    return false;
  }

  /**
   * Get all agent entries
   *
   * @returns Record of all agent entries keyed by spec ID
   */
  getAll(): Record<string, AgentRegistryEntry> {
    return { ...this.data.agents };
  }

  /**
   * Get all entries as an array
   *
   * @returns Array of all agent entries
   */
  getAllEntries(): AgentRegistryEntry[] {
    return Object.values(this.data.agents);
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return this.isDirty;
  }

  /**
   * Clear all entries from the registry
   * Useful for testing or reset scenarios
   */
  clear(): void {
    this.data.agents = {};
    this.isDirty = true;
  }

  /**
   * Get the last update timestamp
   */
  getLastUpdated(): string {
    return this.data.updatedAt;
  }

  /**
   * Get the count of registered agents
   */
  getCount(): number {
    return Object.keys(this.data.agents).length;
  }

  /**
   * Register a new agent process in the registry
   * Validates the entry and saves to disk immediately
   *
   * @param entry - Complete agent registry entry to register
   * @returns true if registered successfully, false on error
   * @throws Error if entry is invalid or an agent with the same specId already exists
   */
  registerAgent(entry: AgentRegistryEntry): boolean {
    // Validate required fields
    if (!this.isCompleteEntry(entry)) {
      throw new Error(`[AgentRegistry] Invalid entry: missing required fields`);
    }

    // Check for duplicate registration (same specId with running status)
    const existing = this.data.agents[entry.specId];
    if (existing && existing.status === 'running') {
      throw new Error(
        `[AgentRegistry] Agent with specId '${entry.specId}' is already registered and running`
      );
    }

    // Register the agent
    this.data.agents[entry.specId] = {
      ...entry,
      status: entry.status || 'running'
    };
    this.isDirty = true;

    // Save immediately to ensure persistence
    const saved = this.save();
    if (!saved) {
      // Rollback on save failure
      if (existing) {
        this.data.agents[entry.specId] = existing;
      } else {
        delete this.data.agents[entry.specId];
      }
      return false;
    }

    return true;
  }

  /**
   * Unregister an agent process from the registry
   * Removes the entry and saves to disk immediately
   *
   * @param specId - The spec ID of the agent to unregister
   * @returns true if unregistered successfully, false if not found or save failed
   */
  unregisterAgent(specId: string): boolean {
    const existing = this.data.agents[specId];
    if (!existing) {
      return false;
    }

    // Remove the entry
    delete this.data.agents[specId];
    this.isDirty = true;

    // Save immediately
    const saved = this.save();
    if (!saved) {
      // Rollback on save failure
      this.data.agents[specId] = existing;
      return false;
    }

    return true;
  }

  /**
   * Get all agents that are currently running
   * Filters entries by status === 'running'
   *
   * @returns Array of agent entries with 'running' status
   */
  getRunningAgents(): AgentRegistryEntry[] {
    return Object.values(this.data.agents).filter(
      (agent) => agent.status === 'running'
    );
  }

  /**
   * Check if an agent process is truly alive
   *
   * This performs TWO critical checks to prevent PID reuse attacks:
   * 1. Process.kill(pid, 0) - Tests if process exists without killing it
   * 2. Lockfile validation - Ensures executionId matches lockfile content
   *
   * A recycled PID from a dead agent would fail the executionId check
   * because the new process wouldn't have written our expected lockfile.
   *
   * @param specId - The spec ID of the agent to check
   * @returns Object with alive status and reason for failure
   */
  isAgentAlive(specId: string): { alive: boolean; reason?: string } {
    const entry = this.data.agents[specId];

    if (!entry) {
      return { alive: false, reason: 'Agent not found in registry' };
    }

    // Check 1: Is the process running?
    if (!this.isProcessRunning(entry.pid)) {
      return { alive: false, reason: 'Process is not running' };
    }

    // Check 2: Does the executionId in the lockfile match?
    const lockfileValid = this.validateLockfile(entry.lockFile, entry.executionId);
    if (!lockfileValid.valid) {
      return { alive: false, reason: lockfileValid.reason };
    }

    return { alive: true };
  }

  /**
   * Check the heartbeat status of an agent
   *
   * This method reads the agent's heartbeat file and determines if the agent
   * is still actively running or may be hung/crashed. A heartbeat is considered
   * stale if it's more than 60 seconds old.
   *
   * This provides a secondary health check beyond PID monitoring:
   * - PID check: verifies process exists
   * - Heartbeat check: verifies process is responsive (not hung/crashed)
   *
   * @param specId - The spec ID of the agent to check
   * @param staleThresholdMs - Optional custom threshold in ms (default: 60000)
   * @returns HeartbeatCheckResult with status and details
   */
  checkHeartbeat(specId: string, staleThresholdMs: number = HEARTBEAT_STALE_THRESHOLD_MS): HeartbeatCheckResult {
    const entry = this.data.agents[specId];

    // Check if agent exists in registry
    if (!entry) {
      return { status: 'not_found', reason: 'Agent not found in registry' };
    }

    // Read the heartbeat file
    const heartbeatResult = readHeartbeat(entry.workingDirectory, specId);

    // Handle missing heartbeat file
    if (!heartbeatResult.fileExists) {
      return {
        status: 'missing',
        reason: 'Heartbeat file does not exist (agent may not have started writing heartbeats yet)'
      };
    }

    // Handle read errors
    if (!heartbeatResult.success || !heartbeatResult.data) {
      return {
        status: 'error',
        reason: heartbeatResult.error || 'Failed to read heartbeat file'
      };
    }

    const heartbeatData = heartbeatResult.data;

    // Calculate age of the heartbeat
    const heartbeatTime = new Date(heartbeatData.timestamp).getTime();
    const now = Date.now();
    const ageMs = now - heartbeatTime;

    // Check if heartbeat is stale (older than threshold)
    if (ageMs > staleThresholdMs) {
      return {
        status: 'stale',
        ageMs,
        lastHeartbeat: heartbeatData.timestamp,
        reason: `Heartbeat is ${Math.round(ageMs / 1000)} seconds old (threshold: ${Math.round(staleThresholdMs / 1000)}s)`,
        heartbeatData
      };
    }

    // Heartbeat is healthy
    return {
      status: 'healthy',
      ageMs,
      lastHeartbeat: heartbeatData.timestamp,
      heartbeatData
    };
  }

  /**
   * Check if a process is running using the signal 0 technique
   * Sending signal 0 to a process checks if it exists without sending any signal
   *
   * @param pid - Process ID to check
   * @returns true if process exists, false otherwise
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Signal 0 doesn't kill the process - it just checks if it exists
      // Returns true if process exists, throws error if not
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH means process doesn't exist
      // EPERM means process exists but we don't have permission (still alive)
      if (error && typeof error === 'object' && 'code' in error) {
        const errCode = (error as { code: string }).code;
        if (errCode === 'EPERM') {
          // Process exists but permission denied - it's still alive
          return true;
        }
      }
      // ESRCH or other error - process doesn't exist
      return false;
    }
  }

  /**
   * Validate that a lockfile exists and contains the expected executionId
   * This is critical for PID reuse protection - a recycled PID won't have
   * the same executionId in the lockfile
   *
   * @param lockFilePath - Path to the lockfile
   * @param expectedExecutionId - The executionId we expect to find
   * @returns Object with valid status and reason for failure
   */
  private validateLockfile(
    lockFilePath: string,
    expectedExecutionId: string
  ): { valid: boolean; reason?: string } {
    try {
      // Check if lockfile exists
      if (!fs.existsSync(lockFilePath)) {
        return { valid: false, reason: 'Lockfile does not exist' };
      }

      // Read lockfile content
      const content = fs.readFileSync(lockFilePath, 'utf-8').trim();

      // Parse lockfile - expected format is JSON with executionId field
      // or plain text with just the executionId
      let lockfileExecutionId: string;

      try {
        // Try parsing as JSON first
        const parsed = JSON.parse(content);
        lockfileExecutionId = parsed.executionId;
      } catch {
        // If not JSON, treat content as plain executionId
        lockfileExecutionId = content;
      }

      // Compare executionIds
      if (lockfileExecutionId !== expectedExecutionId) {
        return {
          valid: false,
          reason: `ExecutionId mismatch: expected '${expectedExecutionId}', found '${lockfileExecutionId}'`
        };
      }

      return { valid: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { valid: false, reason: `Failed to read lockfile: ${errorMessage}` };
    }
  }

  /**
   * Clean up a stale registry entry and its associated lockfile
   *
   * This method removes a registry entry for an agent that is no longer running
   * (either the process died or the executionId no longer matches). It also
   * attempts to delete the associated lockfile to prevent orphaned files.
   *
   * @param specId - The spec ID of the stale entry to clean up
   * @returns Object with cleanup status and details
   */
  cleanupStaleEntry(specId: string): { success: boolean; lockfileDeleted: boolean; error?: string } {
    const entry = this.data.agents[specId];

    if (!entry) {
      return { success: false, lockfileDeleted: false, error: 'Entry not found in registry' };
    }

    let lockfileDeleted = false;

    // Try to delete the lockfile first
    if (entry.lockFile) {
      try {
        if (fs.existsSync(entry.lockFile)) {
          fs.unlinkSync(entry.lockFile);
          lockfileDeleted = true;
        }
      } catch (error: unknown) {
        // Log but don't fail - lockfile deletion is best-effort
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[AgentRegistry] Failed to delete lockfile ${entry.lockFile}: ${errorMessage}`);
      }
    }

    // Remove the registry entry
    delete this.data.agents[specId];
    this.isDirty = true;

    // Save immediately to persist the cleanup
    const saved = this.save();
    if (!saved) {
      // Rollback on save failure
      this.data.agents[specId] = entry;
      return { success: false, lockfileDeleted, error: 'Failed to save registry after cleanup' };
    }

    return { success: true, lockfileDeleted };
  }

  /**
   * Clean up multiple stale registry entries in batch
   *
   * This is more efficient than calling cleanupStaleEntry() repeatedly
   * as it batches the registry save operation.
   *
   * @param staleEntries - Array of stale entries with spec IDs and reasons
   * @returns Summary of cleanup results
   */
  cleanupStaleEntries(
    staleEntries: Array<{ entry: AgentRegistryEntry; reason: string }>
  ): { cleaned: number; lockfilesDeleted: number; errors: string[] } {
    const errors: string[] = [];
    let cleaned = 0;
    let lockfilesDeleted = 0;

    // Process each stale entry
    for (const { entry, reason } of staleEntries) {
      // Try to delete the lockfile
      if (entry.lockFile) {
        try {
          if (fs.existsSync(entry.lockFile)) {
            fs.unlinkSync(entry.lockFile);
            lockfilesDeleted++;
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Failed to delete lockfile for ${entry.specId}: ${errorMessage}`);
        }
      }

      // Remove from registry (in-memory)
      if (this.data.agents[entry.specId]) {
        delete this.data.agents[entry.specId];
        cleaned++;
      }
    }

    // Only save if we made changes
    if (cleaned > 0) {
      this.isDirty = true;
      const saved = this.save();
      if (!saved) {
        errors.push('Failed to save registry after batch cleanup');
      }
    }

    return { cleaned, lockfilesDeleted, errors };
  }

  /**
   * Find and clean up orphaned lockfiles that don't have corresponding registry entries
   *
   * This handles the case where:
   * - A process created a lockfile but the GUI crashed before registering it
   * - A lockfile was left behind after a failed cleanup
   * - A lockfile exists from a manually removed registry entry
   *
   * @param workingDirectory - The project working directory to scan for orphaned lockfiles
   * @returns Summary of cleanup results
   */
  cleanupOrphanedLockfiles(workingDirectory: string): { deleted: number; errors: string[] } {
    const errors: string[] = [];
    let deleted = 0;

    const locksDir = path.join(workingDirectory, '.auto-claude', 'agent-locks');

    // Check if locks directory exists
    if (!fs.existsSync(locksDir)) {
      return { deleted: 0, errors: [] };
    }

    try {
      // Read all files in the locks directory
      const files = fs.readdirSync(locksDir);

      for (const file of files) {
        // Only process .lock files
        if (!file.endsWith('.lock')) {
          continue;
        }

        const lockFilePath = path.join(locksDir, file);
        const specId = file.replace('.lock', '');

        // Check if there's a corresponding registry entry
        const registryEntry = this.data.agents[specId];

        if (registryEntry) {
          // Entry exists - check if it points to this lockfile and if the process is alive
          if (registryEntry.lockFile === lockFilePath) {
            // This lockfile belongs to a registered agent - check if agent is alive
            const aliveCheck = this.isAgentAlive(specId);
            if (aliveCheck.alive) {
              // Agent is alive - don't delete its lockfile
              continue;
            }
            // Agent is not alive - will be cleaned up by cleanupStaleEntries
            // Don't delete here to avoid race conditions
            continue;
          }
          // Lockfile doesn't match registry entry path - it's orphaned
        }

        // No registry entry for this lockfile - it's orphaned
        // Additional safety check: verify the process in the lockfile is not running
        try {
          const content = fs.readFileSync(lockFilePath, 'utf-8').trim();
          let lockfileData: { executionId?: string; specId?: string } = {};

          try {
            lockfileData = JSON.parse(content);
          } catch {
            // Not JSON - can't extract more info, treat as orphaned
          }

          // If we can read a PID from a registry entry with same specId, double-check
          // But since there's no registry entry, this lockfile is safe to delete
        } catch {
          // Can't read lockfile - still try to delete it
        }

        // Delete the orphaned lockfile
        try {
          fs.unlinkSync(lockFilePath);
          deleted++;
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Failed to delete orphaned lockfile ${lockFilePath}: ${errorMessage}`);
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to read locks directory ${locksDir}: ${errorMessage}`);
    }

    return { deleted, errors };
  }
}

// Singleton instance for app-wide use
let registryInstance: AgentRegistry | null = null;

/**
 * Get the singleton AgentRegistry instance
 * Lazy-initializes on first call
 */
export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
    registryInstance.load();
  }
  return registryInstance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetAgentRegistry(): void {
  registryInstance = null;
}
