import { useState, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { Plus, Inbox, Loader2, Eye, CheckCircle2, CircleDot } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { TaskCard } from './TaskCard';
import { SortableTaskCard } from './SortableTaskCard';
import { TASK_STATUS_COLUMNS, TASK_STATUS_LABELS } from '../../shared/constants';
import { cn } from '../lib/utils';
import { persistTaskStatus } from '../stores/task-store';
import type { Task, TaskStatus } from '../../shared/types';

interface KanbanBoardProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onNewTaskClick?: () => void;
}

interface DroppableColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  onAddClick?: () => void;
}

// Column icons mapping
const ColumnIcon: Record<TaskStatus, typeof Inbox> = {
  backlog: Inbox,
  in_progress: Loader2,
  ai_review: CircleDot,
  human_review: Eye,
  done: CheckCircle2
};

// Empty state messages per column
const EmptyStateMessages: Record<TaskStatus, { title: string; description: string }> = {
  backlog: {
    title: 'No tasks in backlog',
    description: 'Create a new task to get started'
  },
  in_progress: {
    title: 'Nothing in progress',
    description: 'Drag a task here to start working'
  },
  ai_review: {
    title: 'AI Review queue empty',
    description: 'Tasks will appear here after completion'
  },
  human_review: {
    title: 'No reviews needed',
    description: "You're all caught up!"
  },
  done: {
    title: 'No completed tasks',
    description: 'Completed tasks will appear here'
  }
};

function DroppableColumn({ status, tasks, onTaskClick, isOver, onAddClick }: DroppableColumnProps) {
  const { setNodeRef } = useDroppable({
    id: status
  });

  const taskIds = tasks.map((t) => t.id);
  const Icon = ColumnIcon[status];
  const emptyState = EmptyStateMessages[status];

  const getColumnBorderColor = (): string => {
    switch (status) {
      case 'backlog':
        return 'column-backlog';
      case 'in_progress':
        return 'column-in-progress';
      case 'ai_review':
        return 'column-ai-review';
      case 'human_review':
        return 'column-human-review';
      case 'done':
        return 'column-done';
      default:
        return 'border-t-muted-foreground/30';
    }
  };

  // Get badge color based on status
  const getBadgeColor = (): string => {
    switch (status) {
      case 'backlog':
        return 'bg-muted text-muted-foreground';
      case 'in_progress':
        return 'bg-info/20 text-info';
      case 'ai_review':
        return 'bg-warning/20 text-warning';
      case 'human_review':
        return 'bg-purple-500/20 text-purple-400';
      case 'done':
        return 'bg-success/20 text-success';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <div
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-xl border border-white/5 bg-gradient-to-b from-secondary/30 to-transparent backdrop-blur-sm transition-all duration-200',
        getColumnBorderColor(),
        'border-t-2',
        isOver && 'drop-zone-active border-primary/50'
      )}
    >
      {/* Column header - enhanced */}
      <div className="flex items-center justify-between p-4 pb-3">
        <div className="flex items-center gap-2.5">
          <Icon className={cn(
            'h-4 w-4',
            status === 'in_progress' && tasks.some(t => t.status === 'in_progress') && 'animate-spin',
            status === 'backlog' && 'text-muted-foreground',
            status === 'in_progress' && 'text-info',
            status === 'ai_review' && 'text-warning',
            status === 'human_review' && 'text-purple-400',
            status === 'done' && 'text-success'
          )} />
          <h2 className="font-semibold text-sm text-foreground">
            {TASK_STATUS_LABELS[status]}
          </h2>
          <span className={cn(
            'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
            getBadgeColor()
          )}>
            {tasks.length}
          </span>
        </div>
        {status === 'backlog' && onAddClick && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors"
            onClick={onAddClick}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Droppable task list */}
      <div ref={setNodeRef} className="flex-1 min-h-0">
        <ScrollArea className="h-full px-3 pb-3">
          <SortableContext
            items={taskIds}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3 min-h-[100px]">
              {tasks.length === 0 ? (
                <div
                  className={cn(
                    'rounded-xl border-2 border-dashed border-border/50 p-6 text-center transition-all duration-200',
                    isOver && 'border-primary/50 bg-primary/5 border-solid'
                  )}
                >
                  {isOver ? (
                    <div className="text-primary font-medium text-sm">
                      Drop here
                    </div>
                  ) : (
                    <div className="empty-state-bounce">
                      <Icon className={cn(
                        'h-8 w-8 mx-auto mb-2 opacity-30',
                        status === 'done' && 'text-success',
                        status === 'human_review' && 'text-purple-400'
                      )} />
                      <p className="text-sm font-medium text-muted-foreground mb-1">
                        {emptyState.title}
                      </p>
                      <p className="text-xs text-muted-foreground/70">
                        {emptyState.description}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                tasks.map((task) => (
                  <SortableTaskCard
                    key={task.id}
                    task={task}
                    onClick={() => onTaskClick(task)}
                  />
                ))
              )}
            </div>
          </SortableContext>
        </ScrollArea>
      </div>
    </div>
  );
}

export function KanbanBoard({ tasks, onTaskClick, onNewTaskClick }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // 8px movement required before drag starts
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      backlog: [],
      in_progress: [],
      ai_review: [],
      human_review: [],
      done: []
    };

    tasks.forEach((task) => {
      if (grouped[task.status]) {
        grouped[task.status].push(task);
      }
    });

    return grouped;
  }, [tasks]);

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find((t) => t.id === active.id);
    if (task) {
      setActiveTask(task);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;

    if (!over) {
      setOverColumnId(null);
      return;
    }

    const overId = over.id as string;

    // Check if over a column
    if (TASK_STATUS_COLUMNS.includes(overId as TaskStatus)) {
      setOverColumnId(overId);
      return;
    }

    // Check if over a task - get its column
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      setOverColumnId(overTask.status);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    setOverColumnId(null);

    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    // Check if dropped on a column
    if (TASK_STATUS_COLUMNS.includes(overId as TaskStatus)) {
      const newStatus = overId as TaskStatus;
      const task = tasks.find((t) => t.id === activeTaskId);

      if (task && task.status !== newStatus) {
        // Persist status change to file and update local state
        persistTaskStatus(activeTaskId, newStatus);
      }
      return;
    }

    // Check if dropped on another task - move to that task's column
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      const task = tasks.find((t) => t.id === activeTaskId);
      if (task && task.status !== overTask.status) {
        // Persist status change to file and update local state
        persistTaskStatus(activeTaskId, overTask.status);
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto p-6">
        {TASK_STATUS_COLUMNS.map((status) => (
          <DroppableColumn
            key={status}
            status={status}
            tasks={tasksByStatus[status]}
            onTaskClick={onTaskClick}
            isOver={overColumnId === status}
            onAddClick={status === 'backlog' ? onNewTaskClick : undefined}
          />
        ))}
      </div>

      {/* Drag overlay - enhanced with better shadow */}
      <DragOverlay>
        {activeTask ? (
          <div className="drag-overlay-shadow opacity-95 rotate-2 scale-105 cursor-grabbing rounded-xl">
            <TaskCard task={activeTask} onClick={() => {}} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
