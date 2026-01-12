const fs = require('fs');

const filePath = 'src/renderer/components/TaskCard.tsx';
let content = fs.readFileSync(filePath, 'utf-8');
content = content.replace(/\r\n/g, '\n');

// First, add the CompactPhaseIndicator import
content = content.replace(
  "import { PhaseProgressIndicator } from './PhaseProgressIndicator';",
  "import { PhaseProgressIndicator, CompactPhaseIndicator } from './PhaseProgressIndicator';"
);

// Add ChevronDown and ChevronRight to lucide imports
content = content.replace(
  "import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, Archive, Ban } from 'lucide-react';",
  "import { Play, Square, Clock, Zap, Target, Shield, Gauge, Palette, FileCode, Bug, Wrench, Loader2, AlertTriangle, RotateCcw, Archive, Ban, ChevronDown, ChevronRight } from 'lucide-react';"
);

// Find and replace the compact view section
const oldCompactView = `// Compact view - minimal card for collapsed mode
  if (compact) {
    return (
      <Card
        className={cn(
          'card-surface task-card-compact cursor-pointer',
          isRunning && !isStuck && 'ring-1 ring-primary border-primary',
          isStuck && 'ring-1 ring-warning border-warning',
          isBlocked && 'ring-1 ring-orange-500/50 border-orange-500/50',
          isArchived && 'opacity-60 hover:opacity-80'
        )}
        onClick={onClick}
      >
        <CardContent className="p-2.5 flex items-center gap-2">
          {/* Status indicator dot */}
          <div className={cn(
            'h-2 w-2 rounded-full shrink-0',
            isStuck ? 'bg-warning animate-pulse' :
            isRunning ? 'bg-primary animate-pulse' :
            isBlocked ? 'bg-orange-500' :
            task.status === 'done' ? 'bg-success' :
            task.status === 'human_review' || task.status === 'ai_review' ? 'bg-purple-500' :
            'bg-muted-foreground/40'
          )} />

          {/* Title */}
          <span className="flex-1 text-sm font-medium text-foreground truncate" title={task.title}>
            {task.title}
          </span>

          {/* Action button */}
          {isBlocked ? (
            <Ban className="h-3.5 w-3.5 text-orange-400 shrink-0" />
          ) : isStuck ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={handleRecover}
              disabled={isRecovering}
            >
              {isRecovering ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3 text-warning" />}
            </Button>
          ) : (task.status === 'backlog' || task.status === 'in_progress') && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-6 w-6 shrink-0', isRunning && 'text-destructive')}
              onClick={handleStartStop}
            >
              {isRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }`;

const newCompactView = `// Compact view - shows essential info with expand toggle
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
                  style={{ width: \`\${progressPercent}%\` }}
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
                    title={\`\${subtask.title || subtask.id}: \${subtask.status}\`}
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
  }`;

if (content.includes(oldCompactView)) {
  content = content.replace(oldCompactView, newCompactView);
  content = content.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, content);
  console.log('SUCCESS: Updated compact card view with progress and phase indicator');
} else {
  console.log('ERROR: Could not find compact view to replace');
  // Debug - check if the imports were updated
  if (content.includes('CompactPhaseIndicator')) {
    console.log('CompactPhaseIndicator import added');
  }
  if (content.includes('ChevronRight')) {
    console.log('ChevronRight import added');
  }
}
