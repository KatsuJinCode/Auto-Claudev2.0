import { create } from 'zustand';
import type { Task, TaskStatus, ImplementationPlan, Subtask, TaskMetadata, ExecutionProgress, ExecutionPhase, ReviewReason, TaskDraft } from '../../shared/types';

/**
 * Log activity state for tracking recent log timestamps per task.
 * Used to derive timer values and activity indicators from actual log data
 * rather than arbitrary counters.
 */
export interface LogActivityState {
  /** Timestamp of the most recent log entry */
  lastLogTimestamp: Date;
  /** Content/message of the most recent log entry */
  lastActivityLog: string;
  /** When the activity tracking was last updated locally */
  localUpdatedAt: Date;
}

/**
 * Threshold in milliseconds to consider activity as "recent".
 * Activity older than this will show as inactive.
 * 5 minutes = 300000ms
 */
export const ACTIVITY_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Minimum interval between log activity updates to prevent UI flicker.
 * Rapid updates within this window will be ignored.
 * 500ms = 0.5 seconds
 */
export const LOG_ACTIVITY_DEBOUNCE_MS = 500;

/**
 * Maximum allowed clock skew tolerance for timestamps.
 * Timestamps beyond this in the future will be rejected.
 * 5 minutes = 300000ms
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Check if a log timestamp is considered recent (within threshold).
 * @param timestamp - The log timestamp to check
 * @param thresholdMs - Optional custom threshold (defaults to ACTIVITY_STALE_THRESHOLD_MS)
 * @returns true if activity is recent, false if stale
 */
export function isActivityRecent(timestamp: Date | undefined, thresholdMs = ACTIVITY_STALE_THRESHOLD_MS): boolean {
  if (!timestamp) return false;
  const now = Date.now();
  const elapsed = now - timestamp.getTime();
  return elapsed < thresholdMs;
}

/**
 * Safely parse a timestamp from various input formats.
 * Returns undefined if parsing fails, allowing caller to fallback.
 * @param input - Date object, ISO string, number (epoch ms), or undefined
 * @returns Parsed Date or undefined if invalid
 */
export function parseTimestamp(input: Date | string | number | undefined | null): Date | undefined {
  if (!input) return undefined;

  try {
    if (input instanceof Date) {
      // Validate Date object
      return isNaN(input.getTime()) ? undefined : input;
    }

    if (typeof input === 'number') {
      // Epoch milliseconds
      const date = new Date(input);
      return isNaN(date.getTime()) ? undefined : date;
    }

    if (typeof input === 'string') {
      // Try ISO string or other date formats
      const date = new Date(input);
      return isNaN(date.getTime()) ? undefined : date;
    }
  } catch {
    // Swallow parsing errors
  }

  return undefined;
}

/**
 * Validate a timestamp for use in log activity tracking.
 * Rejects invalid dates and timestamps too far in the future.
 * @param timestamp - The timestamp to validate
 * @param toleranceMs - Max allowed future time (default: CLOCK_SKEW_TOLERANCE_MS)
 * @returns The timestamp if valid, undefined otherwise
 */
export function validateTimestamp(timestamp: Date | undefined, toleranceMs = CLOCK_SKEW_TOLERANCE_MS): Date | undefined {
  if (!timestamp) return undefined;
  if (isNaN(timestamp.getTime())) return undefined;

  const now = Date.now();
  const maxAllowed = now + toleranceMs;

  // Reject timestamps more than tolerance in the future
  if (timestamp.getTime() > maxAllowed) {
    return undefined;
  }

  return timestamp;
}

interface TaskState {
  tasks: Task[];
  selectedTaskId: string | null;
  isLoading: boolean;
  error: string | null;
  /** Per-task log activity tracking for log-driven timers and activity indicators */
  logActivity: Map<string, LogActivityState>;

  // Actions
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (taskId: string, updates: Partial<Task>) => void;
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  updateTaskFromPlan: (taskId: string, plan: ImplementationPlan) => void;
  updateExecutionProgress: (taskId: string, progress: Partial<ExecutionProgress>) => void;
  appendLog: (taskId: string, log: string) => void;
  /** Clear logs for a task (visual only, file log remains intact) */
  clearTaskLogs: (taskId: string) => void;
  selectTask: (taskId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearTasks: () => void;
  /** Update log activity state for a task (timestamp from actual log entry) */
  updateLogActivity: (taskId: string, timestamp: Date, logContent: string) => void;
  /** Clear log activity for a task (e.g., when task completes or is reset) */
  clearLogActivity: (taskId: string) => void;

  // Selectors
  getSelectedTask: () => Task | undefined;
  getTasksByStatus: (status: TaskStatus) => Task[];
  /** Get log activity state for a task */
  getLogActivity: (taskId: string) => LogActivityState | undefined;
  /** Check if a task has recent activity (within threshold) */
  getIsTaskActivityRecent: (taskId: string) => boolean;

  // Reconciliation
  /**
   * Reconcile task state from execution progress data.
   * This is the primary method for updating task state from IPC events,
   * atomically updating both executionProgress and logActivity.
   * @param taskId - The task ID to update
   * @param progress - Execution progress data including optional timestamp
   */
  reconcileTaskState: (taskId: string, progress: Partial<ExecutionProgress>) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  isLoading: false,
  error: null,
  logActivity: new Map(),

  setTasks: (tasks) => set({ tasks }),

  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, task]
    })),

  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId || t.specId === taskId ? { ...t, ...updates } : t
      )
    })),

  updateTaskStatus: (taskId, status) =>
    set((state) => {
      // Find the task to get canonical ID
      const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
      const canonicalId = task?.id || taskId;

      // When status goes to backlog, also clear log activity
      let newLogActivity = state.logActivity;
      if (status === 'backlog') {
        newLogActivity = new Map(state.logActivity);
        newLogActivity.delete(canonicalId);
      }

      return {
        tasks: state.tasks.map((t) => {
          if (t.id !== taskId && t.specId !== taskId) return t;

          // When status goes to backlog, reset execution progress to idle
          // This ensures the planning/coding animation stops when task is stopped
          const executionProgress = status === 'backlog'
            ? { phase: 'idle' as ExecutionPhase, phaseProgress: 0, overallProgress: 0 }
            : t.executionProgress;

          return { ...t, status, executionProgress, updatedAt: new Date() };
        }),
        logActivity: newLogActivity
      };
    }),

  updateTaskFromPlan: (taskId, plan) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== taskId && t.specId !== taskId) return t;

        // CRITICAL: Once a task is marked 'done' by human review, NEVER auto-change status
        // This prevents stale plan updates from moving tasks out of Done column
        if (t.status === 'done') {
          // Still update subtasks and title, but preserve 'done' status
          const subtasks: Subtask[] = plan.phases.flatMap((phase) =>
            phase.subtasks.map((subtask) => ({
              id: subtask.id,
              title: subtask.description,
              description: subtask.description,
              status: subtask.status,
              files: [],
              verification: subtask.verification as Subtask['verification']
            }))
          );
          return {
            ...t,
            title: plan.feature || t.title,
            subtasks,
            updatedAt: new Date()
          };
        }

        // Extract subtasks from plan
        const subtasks: Subtask[] = plan.phases.flatMap((phase) =>
          phase.subtasks.map((subtask) => ({
            id: subtask.id,
            title: subtask.description,
            description: subtask.description,
            status: subtask.status,
            files: [],
            verification: subtask.verification as Subtask['verification']
          }))
        );

        // Determine status and reviewReason based on subtasks
        // This logic must match the backend (project-store.ts) exactly
        const allCompleted = subtasks.length > 0 && subtasks.every((s) => s.status === 'completed');
        const anyInProgress = subtasks.some((s) => s.status === 'in_progress');
        const anyFailed = subtasks.some((s) => s.status === 'failed');
        const anyCompleted = subtasks.some((s) => s.status === 'completed');

        let status: TaskStatus = t.status;
        let reviewReason: ReviewReason | undefined = t.reviewReason;

        if (allCompleted) {
          // Manual tasks skip AI review and go directly to human review
          status = t.metadata?.sourceType === 'manual' ? 'human_review' : 'ai_review';
          if (t.metadata?.sourceType === 'manual') {
            reviewReason = 'completed';
          } else {
            reviewReason = undefined;
          }
        } else if (anyFailed) {
          // Some subtasks failed - needs human attention
          status = 'human_review';
          reviewReason = 'errors';
        } else if (anyInProgress || anyCompleted) {
          // Work in progress
          status = 'in_progress';
          reviewReason = undefined;
        }

        return {
          ...t,
          title: plan.feature || t.title,
          subtasks,
          status,
          reviewReason,
          updatedAt: new Date()
        };
      })
    })),

  updateExecutionProgress: (taskId, progress) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== taskId && t.specId !== taskId) return t;

        // Merge with existing progress
        const existingProgress = t.executionProgress || {
          phase: 'idle' as ExecutionPhase,
          phaseProgress: 0,
          overallProgress: 0
        };

        return {
          ...t,
          executionProgress: {
            ...existingProgress,
            ...progress
          },
          updatedAt: new Date()
        };
      })
    })),

  appendLog: (taskId, log) =>
    set((state) => {
      // Find the task to get canonical ID
      const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
      const canonicalId = task?.id || taskId;
      const now = new Date();

      // Update log activity tracking with current timestamp
      const newLogActivity = new Map(state.logActivity);
      newLogActivity.set(canonicalId, {
        lastLogTimestamp: now,
        lastActivityLog: log,
        localUpdatedAt: now
      });

      return {
        tasks: state.tasks.map((t) =>
          t.id === taskId || t.specId === taskId
            ? { ...t, logs: [...(t.logs || []), log] }
            : t
        ),
        logActivity: newLogActivity
      };
    }),

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  clearTasks: () => set({ tasks: [], selectedTaskId: null, logActivity: new Map() }),

  getSelectedTask: () => {
    const state = get();
    return state.tasks.find((t) => t.id === state.selectedTaskId);
  },

  getTasksByStatus: (status) => {
    const state = get();
    return state.tasks.filter((t) => t.status === status);
  },

  updateLogActivity: (taskId, timestamp, logContent) =>
    set((state) => {
      const newLogActivity = new Map(state.logActivity);
      // Find the actual task to get the canonical ID
      const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
      const canonicalId = task?.id || taskId;

      newLogActivity.set(canonicalId, {
        lastLogTimestamp: timestamp,
        lastActivityLog: logContent,
        localUpdatedAt: new Date()
      });
      return { logActivity: newLogActivity };
    }),

  clearLogActivity: (taskId) =>
    set((state) => {
      const newLogActivity = new Map(state.logActivity);
      // Find the actual task to get the canonical ID
      const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
      const canonicalId = task?.id || taskId;

      newLogActivity.delete(canonicalId);
      return { logActivity: newLogActivity };
    }),

  getLogActivity: (taskId) => {
    const state = get();
    // Check by both id and specId
    const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
    const canonicalId = task?.id || taskId;
    return state.logActivity.get(canonicalId);
  },

  getIsTaskActivityRecent: (taskId) => {
    const state = get();
    const activity = state.getLogActivity(taskId);
    if (!activity) return false;
    return isActivityRecent(activity.lastLogTimestamp);
  },

  reconcileTaskState: (taskId, progress) =>
    set((state) => {
      // Find the task to get canonical ID
      const task = state.tasks.find((t) => t.id === taskId || t.specId === taskId);
      if (!task) return state;

      const canonicalId = task.id;

      // Get existing activity for fallback and debouncing
      const existingActivity = state.logActivity.get(canonicalId);

      // Parse and validate timestamp using helpers
      const parsedTimestamp = parseTimestamp(progress.timestamp);
      const validatedTimestamp = validateTimestamp(parsedTimestamp);

      // Determine final timestamp: use validated if available, fallback to existing
      let timestamp: Date | undefined = validatedTimestamp;
      if (!timestamp && existingActivity) {
        // Parsing failed - keep previous good timestamp (edge case: parsing errors)
        timestamp = existingActivity.lastLogTimestamp;
      }

      // Update log activity if we have a valid timestamp
      let newLogActivity = state.logActivity;
      if (timestamp) {
        const now = Date.now();
        const logContent = progress.message || progress.currentSubtask || `Phase: ${progress.phase}`;

        // Debounce check: only update if sufficient time has passed since last update
        // This prevents UI flicker from rapid log updates (edge case: rapid updates)
        const shouldUpdate = !existingActivity ||
          (now - existingActivity.localUpdatedAt.getTime()) >= LOG_ACTIVITY_DEBOUNCE_MS ||
          // Always update if the log content changed meaningfully
          existingActivity.lastActivityLog !== logContent;

        if (shouldUpdate) {
          newLogActivity = new Map(state.logActivity);
          newLogActivity.set(canonicalId, {
            lastLogTimestamp: timestamp,
            lastActivityLog: logContent,
            localUpdatedAt: new Date()
          });
        }
      }

      // Update execution progress on the task
      const existingProgress = task.executionProgress || {
        phase: 'idle' as ExecutionPhase,
        phaseProgress: 0,
        overallProgress: 0
      };

      return {
        tasks: state.tasks.map((t) => {
          if (t.id !== canonicalId) return t;

          return {
            ...t,
            executionProgress: {
              ...existingProgress,
              ...progress
            },
            updatedAt: new Date()
          };
        }),
        logActivity: newLogActivity
      };
    })
}));

/**
 * Load tasks for a project
 * Preserves in-memory execution state for running tasks to prevent
 * status from reverting when switching between projects.
 */
export async function loadTasks(projectId: string): Promise<void> {
  const store = useTaskStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getTasks(projectId);
    if (result.success && result.data) {
      // Get existing tasks to preserve execution state
      const existingTasks = store.tasks;

      // Merge: use disk data but preserve execution state for tasks that are running
      const mergedTasks = result.data.map(diskTask => {
        const existingTask = existingTasks.find(t => t.id === diskTask.id || t.specId === diskTask.specId);

        // If task exists in memory and has active execution state, preserve it
        if (existingTask && existingTask.executionProgress) {
          const isRunning = existingTask.executionProgress.phase !== 'idle' &&
                           existingTask.executionProgress.phase !== undefined;

          if (isRunning) {
            // Preserve the in-memory status and execution progress
            return {
              ...diskTask,
              status: existingTask.status,
              executionProgress: existingTask.executionProgress,
              logs: existingTask.logs || diskTask.logs
            };
          }
        }

        return diskTask;
      });

      store.setTasks(mergedTasks);
    } else {
      store.setError(result.error || 'Failed to load tasks');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Create a new task
 */
export async function createTask(
  projectId: string,
  title: string,
  description: string,
  metadata?: TaskMetadata
): Promise<Task | null> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.createTask(projectId, title, description, metadata);
    if (result.success && result.data) {
      store.addTask(result.data);
      return result.data;
    } else {
      store.setError(result.error || 'Failed to create task');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

/**
 * Start a task
 */
export function startTask(taskId: string, options?: { parallel?: boolean; workers?: number }): void {
  window.electronAPI.startTask(taskId, options);
}

/**
 * Stop a task
 */
export function stopTask(taskId: string): void {
  window.electronAPI.stopTask(taskId);
}

/**
 * Submit review for a task
 */
export async function submitReview(
  taskId: string,
  approved: boolean,
  feedback?: string
): Promise<boolean> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.submitReview(taskId, approved, feedback);
    if (result.success) {
      store.updateTaskStatus(taskId, approved ? 'done' : 'in_progress');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Update task status and persist to file
 */
export async function persistTaskStatus(
  taskId: string,
  status: TaskStatus
): Promise<boolean> {
  const store = useTaskStore.getState();

  try {
    // Update local state first for immediate feedback
    store.updateTaskStatus(taskId, status);

    // Persist to file
    const result = await window.electronAPI.updateTaskStatus(taskId, status);
    if (!result.success) {
      console.error('Failed to persist task status:', result.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error persisting task status:', error);
    return false;
  }
}

/**
 * Update task title/description/metadata and persist to file
 */
export async function persistUpdateTask(
  taskId: string,
  updates: { title?: string; description?: string; metadata?: Partial<TaskMetadata> }
): Promise<boolean> {
  const store = useTaskStore.getState();

  try {
    // Call the IPC to persist changes to spec files
    const result = await window.electronAPI.updateTask(taskId, updates);

    if (result.success && result.data) {
      // Update local state with the returned task data
      store.updateTask(taskId, {
        title: result.data.title,
        description: result.data.description,
        metadata: result.data.metadata,
        updatedAt: new Date()
      });
      return true;
    }

    console.error('Failed to persist task update:', result.error);
    return false;
  } catch (error) {
    console.error('Error persisting task update:', error);
    return false;
  }
}

/**
 * Check if a task has an active running process
 */
export async function checkTaskRunning(taskId: string): Promise<boolean> {
  try {
    const result = await window.electronAPI.checkTaskRunning(taskId);
    return result.success && result.data === true;
  } catch (error) {
    console.error('Error checking task running status:', error);
    return false;
  }
}

/**
 * Recover a stuck task (status shows in_progress but no process running)
 * @param taskId - The task ID to recover
 * @param options - Recovery options (autoRestart defaults to true)
 */
export async function recoverStuckTask(
  taskId: string,
  options: { targetStatus?: TaskStatus; autoRestart?: boolean } = { autoRestart: true }
): Promise<{ success: boolean; message: string; autoRestarted?: boolean }> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.recoverStuckTask(taskId, options);

    if (result.success && result.data) {
      // Update local state
      store.updateTaskStatus(taskId, result.data.newStatus);
      return {
        success: true,
        message: result.data.message,
        autoRestarted: result.data.autoRestarted
      };
    }

    return {
      success: false,
      message: result.error || 'Failed to recover task'
    };
  } catch (error) {
    console.error('Error recovering stuck task:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Delete a task and its spec directory
 */
export async function deleteTask(
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  const store = useTaskStore.getState();

  try {
    const result = await window.electronAPI.deleteTask(taskId);

    if (result.success) {
      // Remove from local state
      store.setTasks(store.tasks.filter(t => t.id !== taskId && t.specId !== taskId));
      // Clear selection if this task was selected
      if (store.selectedTaskId === taskId) {
        store.selectTask(null);
      }
      return { success: true };
    }

    return {
      success: false,
      error: result.error || 'Failed to delete task'
    };
  } catch (error) {
    console.error('Error deleting task:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Archive tasks
 * Marks tasks as archived by adding archivedAt timestamp to metadata
 */
export async function archiveTasks(
  projectId: string,
  taskIds: string[],
  version?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await window.electronAPI.archiveTasks(projectId, taskIds, version);

    if (result.success) {
      // Reload tasks to update the UI (archived tasks will be filtered out by default)
      await loadTasks(projectId);
      return { success: true };
    }

    return {
      success: false,
      error: result.error || 'Failed to archive tasks'
    };
  } catch (error) {
    console.error('Error archiving tasks:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// ============================================
// Task Creation Draft Management
// ============================================

const DRAFT_KEY_PREFIX = 'task-creation-draft';

/**
 * Get the localStorage key for a project's draft
 */
function getDraftKey(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}-${projectId}`;
}

/**
 * Save a task creation draft to localStorage
 * Note: For large images, we only store thumbnails in the draft to avoid localStorage limits
 */
export function saveDraft(draft: TaskDraft): void {
  try {
    const key = getDraftKey(draft.projectId);
    // Create a copy with thumbnails only to avoid localStorage size limits
    const draftToStore = {
      ...draft,
      images: draft.images.map(img => ({
        ...img,
        data: undefined // Don't store full image data in localStorage
      })),
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(key, JSON.stringify(draftToStore));
  } catch (error) {
    console.error('Failed to save draft:', error);
  }
}

/**
 * Load a task creation draft from localStorage
 */
export function loadDraft(projectId: string): TaskDraft | null {
  try {
    const key = getDraftKey(projectId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;

    const draft = JSON.parse(stored);
    // Convert savedAt back to Date
    draft.savedAt = new Date(draft.savedAt);
    return draft as TaskDraft;
  } catch (error) {
    console.error('Failed to load draft:', error);
    return null;
  }
}

/**
 * Clear a task creation draft from localStorage
 */
export function clearDraft(projectId: string): void {
  try {
    const key = getDraftKey(projectId);
    localStorage.removeItem(key);
  } catch (error) {
    console.error('Failed to clear draft:', error);
  }
}

/**
 * Check if a draft exists for a project
 */
export function hasDraft(projectId: string): boolean {
  const key = getDraftKey(projectId);
  return localStorage.getItem(key) !== null;
}

/**
 * Check if a draft has any meaningful content (title, description, or images)
 */
export function isDraftEmpty(draft: TaskDraft | null): boolean {
  if (!draft) return true;
  return (
    !draft.title.trim() &&
    !draft.description.trim() &&
    draft.images.length === 0 &&
    !draft.category &&
    !draft.priority &&
    !draft.complexity &&
    !draft.impact
  );
}

// ============================================
// GitHub Issue Linking Helpers
// ============================================

/**
 * Find a task by GitHub issue number
 * Used to check if a task already exists for a GitHub issue
 */
export function getTaskByGitHubIssue(issueNumber: number): Task | undefined {
  const store = useTaskStore.getState();
  return store.tasks.find(t => t.metadata?.githubIssueNumber === issueNumber);
}

// ============================================
// Task State Detection Helpers
// ============================================

/**
 * Check if a task is in human_review but has no completed subtasks.
 * This indicates the task crashed/exited before implementation completed
 * and should be resumed rather than reviewed.
 */
export function isIncompleteHumanReview(task: Task): boolean {
  if (task.status !== 'human_review') return false;

  // If no subtasks defined, task hasn't been planned yet (shouldn't be in human_review)
  if (!task.subtasks || task.subtasks.length === 0) return true;

  // Check if any subtasks are completed
  const completedSubtasks = task.subtasks.filter(s => s.status === 'completed').length;

  // If 0 completed subtasks, this task crashed before implementation
  return completedSubtasks === 0;
}

/**
 * Get the count of completed subtasks for a task
 */
export function getCompletedSubtaskCount(task: Task): number {
  if (!task.subtasks || task.subtasks.length === 0) return 0;
  return task.subtasks.filter(s => s.status === 'completed').length;
}

/**
 * Get task progress info
 */
export function getTaskProgress(task: Task): { completed: number; total: number; percentage: number } {
  const total = task.subtasks?.length || 0;
  const completed = task.subtasks?.filter(s => s.status === 'completed').length || 0;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, percentage };
}
