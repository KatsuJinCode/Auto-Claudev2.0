import type { BrowserWindow } from 'electron';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { IPC_CHANNELS, getSpecsDir, AUTO_BUILD_PATHS } from '../../shared/constants';
import type {
  SDKRateLimitInfo,
  Task,
  TaskStatus,
  Project,
  ImplementationPlan
} from '../../shared/types';
import { AgentManager } from '../agent';
import type { ProcessType, ExecutionProgressData, AgentRegistryEntry } from '../agent';
import { titleGenerator } from '../title-generator';
import { fileWatcher } from '../file-watcher';
import { projectStore } from '../project-store';
import { notificationService } from '../notification-service';

/**
 * Get the spec directory, preferring worktree if it exists.
 *
 * When a worktree exists for a spec, it is the SINGLE source of truth.
 * The main repo's copy is stale once work begins in the worktree.
 */
function getWorktreeAwareSpecDir(
  projectPath: string,
  autoBuildDir: string,
  specId: string
): string {
  // Check worktree first - if it exists, it's the only source of truth
  const worktreeSpecDir = path.join(
    projectPath,
    '.worktrees',
    specId,
    autoBuildDir,
    'specs',
    specId
  );

  if (existsSync(worktreeSpecDir)) {
    return worktreeSpecDir;
  }

  // Fall back to main repo only if no worktree
  return path.join(projectPath, autoBuildDir, 'specs', specId);
}

/**
 * Register all agent-events-related IPC handlers
 */
export function registerAgenteventsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Agent Manager Events → Renderer
  // ============================================

  agentManager.on('log', (taskId: string, log: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_LOG, taskId, log);
    }
  });

  agentManager.on('error', (taskId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, error);
    }
  });

  // Handle SDK rate limit events from agent manager
  agentManager.on('sdk-rate-limit', (rateLimitInfo: SDKRateLimitInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
    }
  });

  // Handle SDK rate limit events from title generator
  titleGenerator.on('sdk-rate-limit', (rateLimitInfo: SDKRateLimitInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
    }
  });

  // Handle agent reconnection events (when GUI reconnects to a detached agent after restart)
  // This notifies the renderer that the task is running so the TaskCard shows correct state
  agentManager.on('reconnect', (taskId: string, entry: AgentRegistryEntry) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      console.log(`[AgentEvents] Agent reconnected: ${taskId} (PID: ${entry.pid})`);

      // Notify renderer that this task is in_progress
      // This ensures the TaskCard shows the correct running state after GUI restart
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'in_progress'
      );

      // Start file watcher for this task if we have the working directory
      // This enables real-time progress updates from implementation_plan.json
      if (entry.workingDirectory) {
        try {
          // Find the project and spec directory for file watching
          const projects = projectStore.getProjects();
          let specDir: string | undefined;

          for (const project of projects) {
            const tasks = projectStore.getTasks(project.id);
            const task = tasks.find((t) => t.id === taskId || t.specId === taskId);

            if (task) {
              const autoBuildDir = project.autoBuildPath || '.auto-claude';
              specDir = getWorktreeAwareSpecDir(project.path, autoBuildDir, task.specId);
              break;
            }
          }

          if (specDir && existsSync(specDir)) {
            fileWatcher.watch(taskId, specDir);
            console.log(`[AgentEvents] Started file watcher for reconnected agent: ${taskId}`);
          }
        } catch (watchError) {
          console.warn(`[AgentEvents] Failed to start file watcher for ${taskId}:`, watchError);
        }
      }
    }
  });

  agentManager.on('exit', (taskId: string, code: number | null, processType: ProcessType) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Stop file watcher
      fileWatcher.unwatch(taskId);

      // Determine new status based on process type and exit code
      // Flow: Planning → In Progress → AI Review (QA agent) → Human Review (QA passed)
      // IMPORTANT: Only move to human_review on SUCCESS. Failures should stay in_progress
      // so the task can be investigated and retried.
      let newStatus: TaskStatus;

      if (processType === 'task-execution') {
        // Task execution completed (includes spec_runner → run.py chain)
        // Success (code 0) = completed successfully → Human Review
        // Failure (code != 0) = error occurred → stay in_progress for retry
        if (code === 0) {
          newStatus = 'human_review';
        } else {
          console.warn(`[Task ${taskId}] Task execution failed with code ${code}, keeping in_progress for retry`);
          return; // Don't change status on failure
        }
      } else if (processType === 'qa-process') {
        // QA retry process completed
        if (code === 0) {
          newStatus = 'human_review';
        } else {
          console.warn(`[Task ${taskId}] QA process failed with code ${code}, keeping in_progress for retry`);
          return; // Don't change status on failure
        }
      } else if (processType === 'spec-creation') {
        // Pure spec creation (shouldn't happen with current flow, but handle it)
        // Stay in backlog/planning
        console.warn(`[Task ${taskId}] Spec creation completed with code ${code}`);
        return;
      } else {
        // Unknown process type - don't change status
        console.warn(`[Task ${taskId}] Unknown process type ${processType}, not changing status`);
        return;
      }

      // Find task and project for status persistence and notifications
      let task: Task | undefined;
      let project: Project | undefined;

      try {
        const projects = projectStore.getProjects();

        for (const p of projects) {
          const tasks = projectStore.getTasks(p.id);
          task = tasks.find((t) => t.id === taskId || t.specId === taskId);
          if (task) {
            project = p;
            break;
          }
        }

        // Persist status to disk so it survives hot reload
        // This is a backup in case the Python backend didn't sync properly
        if (task && project) {
          const autoBuildDir = project.autoBuildPath || '.auto-claude';
          const specDir = getWorktreeAwareSpecDir(project.path, autoBuildDir, task.specId);
          const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

          if (existsSync(planPath)) {
            const planContent = readFileSync(planPath, 'utf-8');
            const plan = JSON.parse(planContent);

            // Only update if not already set to a "further along" status
            // (e.g., don't override 'done' with 'human_review')
            const currentStatus = plan.status;
            const shouldUpdate = !currentStatus ||
              currentStatus === 'in_progress' ||
              currentStatus === 'ai_review' ||
              currentStatus === 'backlog' ||
              currentStatus === 'pending';

            if (shouldUpdate) {
              plan.status = newStatus;
              plan.planStatus = 'review';
              plan.updated_at = new Date().toISOString();
              writeFileSync(planPath, JSON.stringify(plan, null, 2));
              console.warn(`[Task ${taskId}] Persisted status '${newStatus}' to implementation_plan.json`);
            }
          }
        }
      } catch (persistError) {
        console.error(`[Task ${taskId}] Failed to persist status:`, persistError);
      }

      // Send notifications based on task completion status
      if (task && project) {
        const taskTitle = task.title || task.specId;

        if (code === 0) {
          // Task completed successfully - ready for review
          notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);
        } else {
          // Task failed
          notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
        }
      }

      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        newStatus
      );
    }
  });

  agentManager.on('execution-progress', (taskId: string, progress: ExecutionProgressData) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_EXECUTION_PROGRESS, taskId, progress);

      // Auto-move task to AI Review when entering qa_review phase
      if (progress.phase === 'qa_review') {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          'ai_review'
        );
      }
    }
  });

  // ============================================
  // File Watcher Events → Renderer
  // ============================================

  fileWatcher.on('progress', (taskId: string, plan: ImplementationPlan) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_PROGRESS, taskId, plan);
    }
  });

  fileWatcher.on('error', (taskId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, error);
    }
  });
}
