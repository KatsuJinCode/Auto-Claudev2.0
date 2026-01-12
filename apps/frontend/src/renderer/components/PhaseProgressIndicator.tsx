import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import type { ExecutionPhase, TaskLogs, Subtask } from '../../shared/types';

interface PhaseProgressIndicatorProps {
  phase?: ExecutionPhase;
  subtasks: Subtask[];
  phaseLogs?: TaskLogs | null;
  isStuck?: boolean;
  isRunning?: boolean;
  className?: string;
}

// Phase display configuration
const PHASE_CONFIG: Record<ExecutionPhase, { label: string; color: string; bgColor: string }> = {
  idle: { label: 'Idle', color: 'bg-muted-foreground', bgColor: 'bg-muted' },
  planning: { label: 'Planning', color: 'bg-amber-500', bgColor: 'bg-amber-500/20' },
  coding: { label: 'Coding', color: 'bg-info', bgColor: 'bg-info/20' },
  qa_review: { label: 'Reviewing', color: 'bg-purple-500', bgColor: 'bg-purple-500/20' },
  qa_fixing: { label: 'Fixing', color: 'bg-orange-500', bgColor: 'bg-orange-500/20' },
  complete: { label: 'Complete', color: 'bg-success', bgColor: 'bg-success/20' },
  failed: { label: 'Failed', color: 'bg-destructive', bgColor: 'bg-destructive/20' },
};

/**
 * Smart progress indicator that adapts based on execution phase:
 * - Planning/Validation: Shows animated activity bar with entry count
 * - Coding: Shows subtask-based percentage progress
 * - Stuck: Shows warning state with interrupted animation
 */
export function PhaseProgressIndicator({
  phase = 'idle',
  subtasks,
  phaseLogs,
  isStuck = false,
  isRunning = false,
  className,
}: PhaseProgressIndicatorProps) {
  // Calculate subtask-based progress (for coding phase)
  const completedSubtasks = subtasks.filter((c) => c.status === 'completed').length;
  const totalSubtasks = subtasks.length;
  const subtaskProgress = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;

  // Get log entry counts for activity indication
  const planningEntries = phaseLogs?.phases?.planning?.entries?.length || 0;
  const codingEntries = phaseLogs?.phases?.coding?.entries?.length || 0;
  const validationEntries = phaseLogs?.phases?.validation?.entries?.length || 0;

  // Determine which phase log to show activity for
  const getActivePhaseEntries = () => {
    if (phase === 'planning') return planningEntries;
    if (phase === 'qa_review' || phase === 'qa_fixing') return validationEntries;
    return codingEntries;
  };

  // Determine if we should show indeterminate (activity) vs determinate (%) progress
  const isIndeterminatePhase = phase === 'planning' || phase === 'qa_review' || phase === 'qa_fixing';
  const showSubtaskProgress = phase === 'coding' || (totalSubtasks > 0 && !isIndeterminatePhase);

  const config = PHASE_CONFIG[phase] || PHASE_CONFIG.idle;
  const activeEntries = getActivePhaseEntries();

  return (
    <div className={cn('space-y-1.5', className)}>
      {/* Progress label row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {isStuck ? 'Interrupted' : showSubtaskProgress ? 'Progress' : config.label}
          </span>
          {/* Activity indicator dot for non-coding phases */}
          {isRunning && !isStuck && isIndeterminatePhase && (
            <motion.div
              className={cn('h-1.5 w-1.5 rounded-full', config.color)}
              animate={{
                scale: [1, 1.5, 1],
                opacity: [1, 0.5, 1],
              }}
              transition={{
                duration: 1,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
          )}
        </div>
        <span className="text-xs font-medium text-foreground">
          {showSubtaskProgress ? (
            `${subtaskProgress}%`
          ) : activeEntries > 0 ? (
            <span className="text-muted-foreground">
              {activeEntries} {activeEntries === 1 ? 'entry' : 'entries'}
            </span>
          ) : (
            '—'
          )}
        </span>
      </div>

      {/* Progress bar */}
      <div
        className={cn(
          'relative h-1.5 w-full overflow-hidden rounded-full',
          isStuck ? 'bg-warning/20' : 'bg-border'
        )}
      >
        <AnimatePresence mode="wait">
          {isStuck ? (
            // Stuck/Interrupted state - pulsing warning bar
            <motion.div
              key="stuck"
              className="absolute inset-0 bg-warning/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          ) : showSubtaskProgress ? (
            // Determinate progress for coding phase
            <motion.div
              key="determinate"
              className={cn('h-full rounded-full', config.color)}
              initial={{ width: 0 }}
              animate={{ width: `${subtaskProgress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          ) : isRunning && isIndeterminatePhase ? (
            // Indeterminate animated progress for planning/validation
            <motion.div
              key="indeterminate"
              className={cn('absolute h-full w-1/3 rounded-full', config.color)}
              animate={{
                x: ['-100%', '400%'],
              }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
          ) : totalSubtasks > 0 ? (
            // Static progress based on subtasks (when not running)
            <motion.div
              key="static"
              className={cn('h-full rounded-full', config.color)}
              initial={{ width: 0 }}
              animate={{ width: `${subtaskProgress}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          ) : null}
        </AnimatePresence>
      </div>

      {/* Subtask indicators (only show when subtasks exist) */}
      {totalSubtasks > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {subtasks.slice(0, 10).map((subtask, index) => (
            <motion.div
              key={subtask.id || `subtask-${index}`}
              className={cn(
                'h-2 w-2 rounded-full',
                subtask.status === 'completed' && 'bg-success',
                subtask.status === 'in_progress' && 'bg-info',
                subtask.status === 'failed' && 'bg-destructive',
                subtask.status === 'pending' && 'bg-muted-foreground/30'
              )}
              initial={{ scale: 0, opacity: 0 }}
              animate={{
                scale: 1,
                opacity: 1,
                ...(subtask.status === 'in_progress' && {
                  boxShadow: [
                    '0 0 0 0 rgba(var(--info), 0.4)',
                    '0 0 0 4px rgba(var(--info), 0)',
                  ],
                }),
              }}
              transition={{
                scale: { delay: index * 0.03, duration: 0.2 },
                opacity: { delay: index * 0.03, duration: 0.2 },
                boxShadow: subtask.status === 'in_progress'
                  ? { duration: 1, repeat: Infinity, ease: 'easeOut' }
                  : undefined,
              }}
              title={`${subtask.title || subtask.id}: ${subtask.status}`}
            />
          ))}
          {totalSubtasks > 10 && (
            <span key="overflow-count" className="text-[10px] text-muted-foreground font-medium ml-0.5">
              +{totalSubtasks - 10}
            </span>
          )}
        </div>
      )}

      {/* Phase steps indicator (shows overall flow) */}
      {(isRunning || phase !== 'idle') && (
        <PhaseStepsIndicator currentPhase={phase} isStuck={isStuck} />
      )}
    </div>
  );
}

/**
 * Enhanced phase steps indicator showing the full workflow path
 * Like a Mario-style progression through: Spec → Plan → Code → Test → Review → Done
 */
function PhaseStepsIndicator({
  currentPhase,
  isStuck,
  compact = false,
}: {
  currentPhase: ExecutionPhase;
  isStuck: boolean;
  compact?: boolean;
}) {
  // Extended phases for better visibility into progress
  const phases: { key: string; label: string; icon?: string }[] = compact
    ? [
        { key: 'planning', label: 'Plan' },
        { key: 'coding', label: 'Code' },
        { key: 'qa_review', label: 'QA' },
      ]
    : [
        { key: 'spec', label: 'Spec' },
        { key: 'planning', label: 'Plan' },
        { key: 'coding', label: 'Code' },
        { key: 'testing', label: 'Test' },
        { key: 'qa_review', label: 'Review' },
        { key: 'complete', label: 'Done' },
      ];

  const getPhaseState = (phaseKey: string) => {
    // Map display phases to actual execution phases
    const phaseMapping: Record<string, number> = {
      'spec': 0,
      'planning': 1,
      'coding': 2,
      'testing': 3,
      'qa_review': 4,
      'qa_fixing': 4,
      'complete': 5,
    };

    const executionPhaseIndex: Record<ExecutionPhase, number> = {
      'idle': -1,
      'planning': 1,
      'coding': 2,
      'qa_review': 4,
      'qa_fixing': 4,
      'complete': 5,
      'failed': -2,
    };

    const currentIndex = executionPhaseIndex[currentPhase] ?? -1;
    const phaseIndex = phaseMapping[phaseKey] ?? 0;

    // Spec is always complete once we've started (we need a spec to get here)
    if (phaseKey === 'spec' && currentIndex >= 0) return 'complete';

    // Testing happens during coding phase (as subtasks complete)
    if (phaseKey === 'testing') {
      if (currentIndex > 2) return 'complete';
      if (currentIndex === 2) return 'active'; // During coding, testing is part of it
      return 'pending';
    }

    if (currentPhase === 'failed') return phaseIndex <= currentIndex ? 'failed' : 'pending';
    if (currentPhase === 'complete') return 'complete';

    // Current phase handling
    if (phaseKey === currentPhase ||
        (phaseKey === 'qa_review' && currentPhase === 'qa_fixing')) {
      return isStuck ? 'stuck' : 'active';
    }

    if (phaseIndex < currentIndex) return 'complete';
    return 'pending';
  };

  return (
    <div className={cn('flex items-center', compact ? 'gap-0.5' : 'gap-1 mt-2')}>
      {phases.map((phase, index) => {
        const state = getPhaseState(phase.key);
        return (
          <div key={phase.key} className="flex items-center">
            {/* Phase node */}
            <motion.div
              className={cn(
                'flex items-center justify-center rounded font-medium transition-colors',
                compact ? 'h-4 min-w-4 px-1 text-[8px]' : 'gap-1 px-1.5 py-0.5 text-[9px]',
                state === 'complete' && 'bg-success/20 text-success',
                state === 'active' && 'bg-primary/20 text-primary',
                state === 'stuck' && 'bg-warning/20 text-warning',
                state === 'failed' && 'bg-destructive/20 text-destructive',
                state === 'pending' && 'bg-muted/50 text-muted-foreground/60'
              )}
              animate={
                state === 'active' && !isStuck
                  ? { opacity: [1, 0.6, 1] }
                  : { opacity: 1 }
              }
              transition={
                state === 'active' && !isStuck
                  ? { duration: 1.5, repeat: Infinity, ease: 'easeInOut' }
                  : undefined
              }
              title={phase.label}
            >
              {state === 'complete' ? (
                <svg className={cn(compact ? 'h-2 w-2' : 'h-2.5 w-2.5')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              ) : compact ? (
                // Compact: just show first letter
                phase.label[0]
              ) : (
                phase.label
              )}
            </motion.div>

            {/* Connector line */}
            {index < phases.length - 1 && (
              <div
                className={cn(
                  'h-px mx-0.5 transition-colors',
                  compact ? 'w-1' : 'w-2',
                  getPhaseState(phases[index + 1].key) === 'complete' ? 'bg-success/50' :
                  getPhaseState(phases[index + 1].key) === 'active' ? 'bg-primary/50' :
                  'bg-border/50'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Export a standalone compact phase indicator for use in compact cards
 */
export function CompactPhaseIndicator({
  phase = 'idle',
  isStuck = false,
}: {
  phase?: ExecutionPhase;
  isStuck?: boolean;
}) {
  return <PhaseStepsIndicator currentPhase={phase} isStuck={isStuck} compact />;
}
