const fs = require('fs');

// Step 1: Update TaskCard to support compact mode
const taskCardPath = 'src/renderer/components/TaskCard.tsx';
let taskCardContent = fs.readFileSync(taskCardPath, 'utf-8');
taskCardContent = taskCardContent.replace(/\r\n/g, '\n');

// Update TaskCardProps interface
const oldPropsInterface = `interface TaskCardProps {
  task: Task;
  onClick: () => void;
}`;

const newPropsInterface = `interface TaskCardProps {
  task: Task;
  onClick: () => void;
  compact?: boolean;
}`;

taskCardContent = taskCardContent.replace(oldPropsInterface, newPropsInterface);

// Update function signature
const oldFuncSig = `export function TaskCard({ task, onClick }: TaskCardProps) {`;
const newFuncSig = `export function TaskCard({ task, onClick, compact = false }: TaskCardProps) {`;
taskCardContent = taskCardContent.replace(oldFuncSig, newFuncSig);

// Add compact card rendering - find the return statement and insert compact early return
const returnIndex = taskCardContent.indexOf('return (\n    <Card');
if (returnIndex !== -1) {
  // Find where to insert the compact view (before the normal return)
  const insertPoint = returnIndex;

  const compactView = `// Compact view - minimal card for collapsed mode
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
  }

  `;

  taskCardContent = taskCardContent.slice(0, insertPoint) + compactView + taskCardContent.slice(insertPoint);
}

// Convert back to CRLF and save
taskCardContent = taskCardContent.replace(/\n/g, '\r\n');
fs.writeFileSync(taskCardPath, taskCardContent);
console.log('SUCCESS: Updated TaskCard with compact mode');

// Step 2: Update SortableTaskCard to support compact mode
const sortableTaskCardPath = 'src/renderer/components/SortableTaskCard.tsx';
let sortableContent = fs.readFileSync(sortableTaskCardPath, 'utf-8');
sortableContent = sortableContent.replace(/\r\n/g, '\n');

// Check current structure
if (sortableContent.includes('compact?')) {
  console.log('SortableTaskCard already has compact prop');
} else {
  // Update props interface
  sortableContent = sortableContent.replace(
    /interface SortableTaskCardProps \{[^}]+\}/,
    `interface SortableTaskCardProps {
  task: Task;
  onClick: () => void;
  compact?: boolean;
}`
  );

  // Update function signature
  sortableContent = sortableContent.replace(
    /export function SortableTaskCard\(\{ task, onClick \}: SortableTaskCardProps\)/,
    'export function SortableTaskCard({ task, onClick, compact }: SortableTaskCardProps)'
  );

  // Update TaskCard usage
  sortableContent = sortableContent.replace(
    /<TaskCard task=\{task\} onClick=\{onClick\} \/>/g,
    '<TaskCard task={task} onClick={onClick} compact={compact} />'
  );

  sortableContent = sortableContent.replace(/\n/g, '\r\n');
  fs.writeFileSync(sortableTaskCardPath, sortableContent);
  console.log('SUCCESS: Updated SortableTaskCard with compact prop');
}
