<<<<<<< HEAD
import { useState, useEffect } from 'react';
import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, Archive, Ban, ChevronDown, ChevronRight } from 'lucide-react';
=======
import { useState, useEffect, useMemo } from 'react';
import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, Archive, Ban, Activity, Moon } from 'lucide-react';
>>>>>>> auto-claude/004-ui-state-reliability
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from './ui/tooltip';
import { cn, formatRelativeTime, sanitizeMarkdownForDisplay } from '../lib/utils';
import { PhaseProgressIndicator, CompactPhaseIndicator } from './PhaseProgressIndicator';
import {
  TASK_CATEGORY_LABELS,
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  TASK_COMPLEXITY_LABELS,
  TASK_IMPACT_COLORS,
  TASK_IMPACT_LABELS,
  TASK_PRIORITY_COLORS,
  TASK_PRIORITY_LABELS,
  EXECUTION_PHASE_LABELS,
  EXECUTION_PHASE_BADGE_COLORS
} from '../../shared/constants';
import { useTaskStore, startTask, stopTask, checkTaskRunning, recoverStuckTask, isIncompleteHumanReview, archiveTasks, isActivityRecent } from '../stores/task-store';
import type { Task, TaskCategory, ReviewReason } from '../../shared/types';

// Category icon mapping
const CategoryIcon: Record<TaskCategory, typeof Zap> = {
  feature: Target,
  bug_fix: Bug,
  refactoring: Wrench,
  documentation: FileCode,
  security: Shield,
  performance: Gauge,
  ui_ux: Palette,
  infrastructure: Wrench,
  testing: FileCode
};

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  compact?: boolean;
}

export function TaskCard({ task, onClick, compact = false }: TaskCardProps) {
  const [isStuck, setIsStuck] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [, setTimeRefresh] = useState(0); // Forces re-render for relative time display

  // Get log activity for this task to show log-based timer
  const logActivity = useTaskStore((state) => state.logActivity.get(task.id));

  // Refresh relative time display every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeRefresh((prev) => prev + 1);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const isRunning = task.status === 'in_progress';
  const isBlocked = task.status === 'blocked';
  const executionPhase = task.executionProgress?.phase;
  const hasActiveExecution = executionPhase && executionPhase !== 'idle' && executionPhase !== 'complete' && executionPhase !== 'failed';

  // Get dependency names for blocked tasks
  // Uses depends_on field (when available) or falls back to metadata.dependencies
  const blockedByDependencies = task.depends_on || task.metadata?.dependencies || [];

  // Check if task is in human_review but has no completed subtasks (crashed/incomplete)
  const isIncomplete = isIncompleteHumanReview(task);

  // Check if task has recent log activity (for Active badge)
  const isActive = isRunning && !isStuck && isActivityRecent(logActivity?.lastLogTimestamp);

  // Check if task is running but has no recent activity (for Inactive badge)
  // This indicates the agent may be stalled or waiting - shows after threshold passes
  const isInactive = useMemo(() => {
    if (!isRunning || isStuck) return false;
    // Only show inactive if we have some log activity history but it's stale
    if (!logActivity?.lastLogTimestamp) return false;
    return !isActivityRecent(logActivity.lastLogTimestamp);
  }, [isRunning, isStuck, logActivity?.lastLogTimestamp]);

  // Check if task is stuck (status says in_progress but no actual process)
  // Add a grace period to avoid false positives during process spawn
  useEffect(() => {
    if (!isRunning) {
      setIsStuck(false);
      return;
    }

    // Initial check after 2s grace period
    const initialTimeout = setTimeout(() => {
      checkTaskRunning(task.id).then((actuallyRunning) => {
        setIsStuck(!actuallyRunning);
      });
    }, 2000);

    // Periodic re-check every 15 seconds
    const recheckInterval = setInterval(() => {
      checkTaskRunning(task.id).then((actuallyRunning) => {
        setIsStuck(!actuallyRunning);
      });
    }, 15000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(recheckInterval);
    };
  }, [task.id, isRunning]);

  // Add visibility change handler to re-validate on focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isRunning) {
        checkTaskRunning(task.id).then((actuallyRunning) => {
          setIsStuck(!actuallyRunning);
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [task.id, isRunning]);

  const handleStartStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning && !isStuck) {
      stopTask(task.id);
    } else {
      startTask(task.id);
    }
  };

  const handleRecover = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRecovering(true);
    // Auto-restart the task after recovery (no need to click Start again)
    const result = await recoverStuckTask(task.id, { autoRestart: true });
    if (result.success) {
      setIsStuck(false);
    }
    setIsRecovering(false);
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await archiveTasks(task.projectId, [task.id]);
  };

  // Map status to badge variant that matches Kanban column border colors
  // Column colors defined in globals.css: column-backlog, column-in-progress, etc.
  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'info'; // matches column-in-progress: var(--info)
      case 'blocked':
        return 'warning';
      case 'ai_review':
        return 'warning'; // matches column-ai-review: var(--warning)
      case 'human_review':
        return 'purple'; // matches column-human-review: #A855F7
      case 'done':
        return 'success'; // matches column-done: var(--success)
      default:
        return 'muted'; // matches column-backlog: var(--muted-foreground)
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'in_progress':
        return 'Running';
      case 'blocked':
        return 'Blocked';
      case 'ai_review':
        return 'AI Review';
      case 'human_review':
        return 'Needs Review';
      case 'done':
        return 'Complete';
      default:
        return 'Pending';
    }
  };

  const getReviewReasonLabel = (reason?: ReviewReason): { label: string; variant: 'success' | 'destructive' | 'warning' } | null => {
    if (!reason) return null;
    switch (reason) {
      case 'completed':
        return { label: 'Completed', variant: 'success' };
      case 'errors':
        return { label: 'Has Errors', variant: 'destructive' };
      case 'qa_rejected':
        return { label: 'QA Issues', variant: 'warning' };
      case 'plan_review':
        return { label: 'Approve Plan', variant: 'warning' };
      default:
        return null;
    }
  };

  const reviewReasonInfo = task.status === 'human_review' ? getReviewReasonLabel(task.reviewReason) : null;

  const isArchived = !!task.metadata?.archivedAt;

  // Compact view - shows essential info with expand toggle
  if (compact) {
    const completedSubtasks = task.subtasks.filter((s) => s.status === 'completed').length;
    const totalSubtasks = task.subtasks.length;
    const progressPercent = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

    return (
      <Card
        className={cn(
          'card-surface task-card-compact cursor-pointer transition-all',
          isRunning && !isStuck && 'ring-1 ring-primary/50 border-primary/50',
          isStuck && 'ring-1 ring-warning/50 border-warning/50',
          isBlocked && 'ring-1 ring-orange-500/30 border-orange-500/30',
          isArchived && 'opacity-60 hover:opacity-80'
        )}
        onClick={onClick}
      >
        <CardContent className="p-2.5 space-y-2">
          {/* Header row: expand toggle + title */}
          <div className="flex items-center gap-2">
            {/* Expand indicator */}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />

            {/* Title */}
            <span className="flex-1 text-sm font-medium text-foreground truncate" title={task.title}>
              {task.title}
            </span>

            {/* Status indicator */}
            {isStuck && <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />}
            {isBlocked && <Ban className="h-3.5 w-3.5 text-orange-400 shrink-0" />}
          </div>

          {/* Progress section */}
          <div className="flex items-center gap-2">
            {/* Phase indicator (Mario path) */}
            <CompactPhaseIndicator phase={executionPhase} isStuck={isStuck} />

            {/* Progress bar */}
            {totalSubtasks > 0 && (
              <div className="flex-1 h-1 bg-border/50 rounded-full overflow-hidden min-w-8">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    isStuck ? 'bg-warning' :
                    task.status === 'done' ? 'bg-success' :
                    'bg-primary'
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}

            {/* Subtask dots */}
            {totalSubtasks > 0 && totalSubtasks <= 8 && (
              <div className="flex gap-0.5 shrink-0">
                {task.subtasks.map((subtask, index) => (
                  <div
                    key={subtask.id || index}
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      subtask.status === 'completed' && 'bg-success',
                      subtask.status === 'in_progress' && 'bg-info animate-pulse',
                      subtask.status === 'failed' && 'bg-destructive',
                      subtask.status === 'pending' && 'bg-muted-foreground/30'
                    )}
                    title={`${subtask.title || subtask.id}: ${subtask.status}`}
                  />
                ))}
              </div>
            )}

            {/* Show count if too many subtasks */}
            {totalSubtasks > 8 && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {completedSubtasks}/{totalSubtasks}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        'card-surface task-card-enhanced cursor-pointer',
        isRunning && !isStuck && 'ring-2 ring-primary border-primary task-running-pulse',
        isStuck && 'ring-2 ring-warning border-warning task-stuck-pulse',
        isBlocked && 'ring-2 ring-orange-500/50 border-orange-500/50',
        isArchived && 'opacity-60 hover:opacity-80'
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        {/* Header - improved visual hierarchy */}
        <div className="flex items-start justify-between gap-3">
          <h3
            className="font-semibold text-sm text-foreground line-clamp-2 leading-snug flex-1 min-w-0"
            title={task.title}
          >
            {task.title}
          </h3>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end max-w-[160px]">
            {/* Stuck indicator - highest priority */}
            {isStuck && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-warning/10 text-warning border-warning/30 badge-priority-urgent"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                Stuck
              </Badge>
            )}
            {/* Incomplete indicator - task in human_review but no subtasks completed */}
            {isIncomplete && !isStuck && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-orange-500/10 text-orange-400 border-orange-500/30"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                Incomplete
              </Badge>
            )}
            {/* Blocked indicator - task has unmet dependencies */}
            {isBlocked && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-orange-500/10 text-orange-400 border-orange-500/30"
                title={blockedByDependencies.length > 0 ? `Blocked by: ${blockedByDependencies.join(', ')}` : 'Blocked by unmet dependencies'}
              >
                <Ban className="h-2.5 w-2.5" />
                Blocked
              </Badge>
            )}
            {/* Archived indicator - task has been released */}
            {task.metadata?.archivedAt && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-muted text-muted-foreground border-border"
              >
                <Archive className="h-2.5 w-2.5" />
                Archived
              </Badge>
            )}
            {/* Activity indicator - shows when agent is actively processing (recent log activity) */}
            {isActive && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-success/10 text-success border-success/30 activity-indicator-dot"
              >
                <Activity className="h-2.5 w-2.5" />
                Active
              </Badge>
            )}
            {/* Inactive indicator - shows when task is running but no recent log activity (stale) */}
            {isInactive && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 flex items-center gap-1 bg-muted text-muted-foreground border-border"
                title="No recent activity detected - agent may be waiting or stalled"
              >
                <Moon className="h-2.5 w-2.5" />
                Inactive
              </Badge>
            )}
            {/* Execution phase badge - shown when actively running */}
            {hasActiveExecution && executionPhase && !isStuck && !isIncomplete && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] px-1.5 py-0.5 flex items-center gap-1',
                  EXECUTION_PHASE_BADGE_COLORS[executionPhase]
                )}
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {EXECUTION_PHASE_LABELS[executionPhase]}
              </Badge>
            )}
            {/* Status badge - hide when execution phase badge is showing */}
            {!hasActiveExecution && (
              <Badge
                variant={isStuck ? 'warning' : isIncomplete ? 'warning' : getStatusBadgeVariant(task.status)}
                className="text-[10px] px-1.5 py-0.5"
              >
                {isStuck ? 'Needs Recovery' : isIncomplete ? 'Needs Resume' : getStatusLabel(task.status)}
              </Badge>
            )}
            {/* Review reason badge - explains why task needs human review */}
            {reviewReasonInfo && !isStuck && !isIncomplete && (
              <Badge
                variant={reviewReasonInfo.variant}
                className="text-[10px] px-1.5 py-0.5"
              >
                {reviewReasonInfo.label}
              </Badge>
            )}
          </div>
        </div>

        {/* Description - sanitized to handle markdown content */}
        {task.description && (
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
            {sanitizeMarkdownForDisplay(task.description, 150)}
          </p>
        )}

        {/* Blocked dependencies info */}
        {isBlocked && blockedByDependencies.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-orange-400">
            <Ban className="h-3 w-3 shrink-0" />
            <span className="text-muted-foreground">Waiting for:</span>
            {blockedByDependencies.map((dep, index) => (
              <span key={dep} className="font-medium">
                {dep}{index < blockedByDependencies.length - 1 ? ',' : ''}
              </span>
            ))}
          </div>
        )}

        {/* Metadata badges */}
        {task.metadata && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {/* Category badge with icon */}
            {task.metadata.category && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_CATEGORY_COLORS[task.metadata.category])}
              >
                {CategoryIcon[task.metadata.category] && (
                  (() => {
                    const Icon = CategoryIcon[task.metadata.category!];
                    return <Icon className="h-2.5 w-2.5 mr-0.5" />;
                  })()
                )}
                {TASK_CATEGORY_LABELS[task.metadata.category]}
              </Badge>
            )}
            {/* Impact badge - high visibility for important tasks */}
            {task.metadata.impact && (task.metadata.impact === 'high' || task.metadata.impact === 'critical') && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.impact])}
              >
                {TASK_IMPACT_LABELS[task.metadata.impact]}
              </Badge>
            )}
            {/* Complexity badge */}
            {task.metadata.complexity && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_COMPLEXITY_COLORS[task.metadata.complexity])}
              >
                {TASK_COMPLEXITY_LABELS[task.metadata.complexity]}
              </Badge>
            )}
            {/* Priority badge - only show urgent/high */}
            {task.metadata.priority && (task.metadata.priority === 'urgent' || task.metadata.priority === 'high') && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_PRIORITY_COLORS[task.metadata.priority])}
              >
                {TASK_PRIORITY_LABELS[task.metadata.priority]}
              </Badge>
            )}
            {/* Security severity - always show */}
            {task.metadata.securitySeverity && (
              <Badge
                variant="outline"
                className={cn('text-[10px] px-1.5 py-0', TASK_IMPACT_COLORS[task.metadata.securitySeverity])}
              >
                {task.metadata.securitySeverity} severity
              </Badge>
            )}
          </div>
        )}

        {/* Progress section - Phase-aware with animations */}
        {(task.subtasks.length > 0 || hasActiveExecution || isRunning || isStuck) && (
          <div className="mt-4">
            <PhaseProgressIndicator
              phase={executionPhase}
              subtasks={task.subtasks}
              isStuck={isStuck}
              isRunning={isRunning}
            />
          </div>
        )}

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {/* Use lastLogTimestamp from log activity when available for accurate elapsed time */}
            <span>{formatRelativeTime(logActivity?.lastLogTimestamp ?? task.updatedAt)}</span>
          </div>

          {/* Action buttons */}
          {isBlocked ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-7 px-2.5 opacity-50 cursor-not-allowed"
                      disabled
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Ban className="mr-1.5 h-3 w-3" />
                      Start
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <div className="text-sm">
                    <p className="font-medium text-orange-400 mb-1">Blocked by dependencies</p>
                    {blockedByDependencies.length > 0 ? (
                      <p className="text-muted-foreground">
                        Waiting for: {blockedByDependencies.join(', ')}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">
                        Dependencies must be completed first
                      </p>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : isStuck ? (
            <Button
              variant="warning"
              size="sm"
              className="h-7 px-2.5"
              onClick={handleRecover}
              disabled={isRecovering}
            >
              {isRecovering ? (
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Recovering...
                </>
              ) : (
                <>
                  <RotateCcw className="mr-1.5 h-3 w-3" />
                  Recover
                </>
              )}
            </Button>
          ) : isIncomplete ? (
            <Button
              variant="default"
              size="sm"
              className="h-7 px-2.5"
              onClick={handleStartStop}
            >
              <Play className="mr-1.5 h-3 w-3" />
              Resume
            </Button>
          ) : task.status === 'done' && !task.metadata?.archivedAt ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 hover:bg-muted-foreground/10"
              onClick={handleArchive}
              title="Archive task"
            >
              <Archive className="mr-1.5 h-3 w-3" />
              Archive
            </Button>
          ) : (task.status === 'backlog' || task.status === 'in_progress') && (
            <Button
              variant={isRunning ? 'destructive' : 'default'}
              size="sm"
              className="h-7 px-2.5"
              onClick={handleStartStop}
            >
              {isRunning ? (
                <>
                  <Square className="mr-1.5 h-3 w-3" />
                  Stop
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-3 w-3" />
                  Start
                </>
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
