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
