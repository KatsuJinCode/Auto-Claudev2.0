const fs = require('fs');

// Update PhaseProgressIndicator with enhanced phase steps
const filePath = 'src/renderer/components/PhaseProgressIndicator.tsx';
let content = fs.readFileSync(filePath, 'utf-8');
content = content.replace(/\r\n/g, '\n');

// Replace the PhaseStepsIndicator function with an enhanced version
const oldPhaseSteps = `/**
 * Mini phase steps indicator showing the overall flow
 */
function PhaseStepsIndicator({
  currentPhase,
  isStuck,
}: {
  currentPhase: ExecutionPhase;
  isStuck: boolean;
}) {
  const phases: { key: ExecutionPhase; label: string }[] = [
    { key: 'planning', label: 'Plan' },
    { key: 'coding', label: 'Code' },
    { key: 'qa_review', label: 'QA' },
  ];

  const getPhaseState = (phaseKey: ExecutionPhase) => {
    const phaseOrder = ['planning', 'coding', 'qa_review', 'qa_fixing', 'complete'];
    const currentIndex = phaseOrder.indexOf(currentPhase);
    const phaseIndex = phaseOrder.indexOf(phaseKey);

    if (currentPhase === 'failed') return 'failed';
    if (currentPhase === 'complete') return 'complete';
    if (phaseKey === currentPhase || (phaseKey === 'qa_review' && currentPhase === 'qa_fixing')) {
      return isStuck ? 'stuck' : 'active';
    }
    if (phaseIndex < currentIndex) return 'complete';
    return 'pending';
  };

  return (
    <div className="flex items-center gap-1 mt-2">
      {phases.map((phase, index) => {
        const state = getPhaseState(phase.key);
        return (
          <div key={phase.key} className="flex items-center">
            <motion.div
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium',
                state === 'complete' && 'bg-success/10 text-success',
                state === 'active' && 'bg-primary/10 text-primary',
                state === 'stuck' && 'bg-warning/10 text-warning',
                state === 'failed' && 'bg-destructive/10 text-destructive',
                state === 'pending' && 'bg-muted text-muted-foreground'
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
            >
              {state === 'complete' && (
                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {phase.label}
            </motion.div>
            {index < phases.length - 1 && (
              <div
                className={cn(
                  'w-2 h-px mx-0.5',
                  getPhaseState(phases[index + 1].key) !== 'pending' ? 'bg-success/50' : 'bg-border'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}`;

const newPhaseSteps = `/**
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
}`;

if (content.includes(oldPhaseSteps)) {
  content = content.replace(oldPhaseSteps, newPhaseSteps);
  content = content.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, content);
  console.log('SUCCESS: Updated PhaseStepsIndicator with enhanced phases');
} else {
  console.log('ERROR: Could not find PhaseStepsIndicator to replace');
  // Debug
  const startMarker = '/**\n * Mini phase steps indicator';
  const idx = content.indexOf(startMarker);
  console.log('Found start marker at:', idx);
}
