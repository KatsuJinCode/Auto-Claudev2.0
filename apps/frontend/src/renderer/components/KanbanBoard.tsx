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
import { Plus, Inbox, Loader2, Eye, CheckCircle2, Archive, RefreshCw, ChevronDown, ChevronRight, Ban, AlertTriangle } from 'lucide-react';
import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { TaskCard } from './TaskCard';
import { SortableTaskCard } from './SortableTaskCard';
import {
  KANBAN_COLUMNS,
  KANBAN_COLUMN_CONFIG,
  QUEUE_SUBSECTIONS,
  type KanbanColumnId,
  type QueueSubsection
} from '../../shared/constants';
import { cn } from '../lib/utils';
import { persistTaskStatus, archiveTasks } from '../stores/task-store';
import type { Task, TaskStatus } from '../../shared/types';

interface KanbanBoardProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  onNewTaskClick?: () => void;
  onRefreshClick?: () => void;
}

function categorizeQueueTask(task: Task): QueueSubsection {
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'human_review' && task.reviewReason === 'errors') return 'failed';
  return 'unstarted';
}

function getKanbanColumn(task: Task): KanbanColumnId {
  switch (task.status) {
    case 'backlog':
    case 'blocked':
      return 'queue';
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
      return 'review';
    case 'human_review':
      return task.reviewReason === 'errors' ? 'queue' : 'review';
    case 'done':
      return 'done';
    default:
      return 'queue';
  }
}

function columnToStatus(columnId: KanbanColumnId, subsection?: QueueSubsection): TaskStatus {
  switch (columnId) {
    case 'queue':
      if (subsection === 'blocked') return 'blocked';
      return 'backlog';
    case 'in_progress':
      return 'in_progress';
    case 'review':
      return 'human_review';
    case 'done':
      return 'done';
    default:
      return 'backlog';
  }
}

interface QueueSubsectionProps {
  subsection: QueueSubsection;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
}

function QueueSubsectionComponent({ subsection, tasks, onTaskClick, isOver, isCollapsed, onToggle }: QueueSubsectionProps) {
  const droppableId = `queue-${subsection}`;
  const { setNodeRef } = useDroppable({ id: droppableId });
  const taskIds = tasks.map((t) => t.id);
  const config = QUEUE_SUBSECTIONS.find(s => s.id === subsection);

  const getSubsectionIcon = () => {
    switch (subsection) {
      case 'blocked': return <Ban className="h-3.5 w-3.5 text-orange-400" />;
      case 'failed': return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
      default: return <Inbox className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const getSubsectionStyles = () => {
    switch (subsection) {
      case 'blocked': return 'border-orange-500/30 bg-orange-500/5';
      case 'failed': return 'border-destructive/30 bg-destructive/5';
      default: return 'border-border/50 bg-transparent';
    }
  };

  return (
    <div ref={setNodeRef} className={cn('rounded-lg border transition-all duration-200', getSubsectionStyles(), isOver && 'ring-2 ring-primary/50 bg-primary/5')}>
      <button className="w-full flex items-center justify-between p-2 hover:bg-white/5 rounded-t-lg transition-colors" onClick={onToggle}>
        <div className="flex items-center gap-2">
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          {getSubsectionIcon()}
          <span className="text-xs font-medium text-foreground">{config?.label || subsection}</span>
          <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded-full bg-muted/50">{tasks.length}</span>
        </div>
      </button>
      {!isCollapsed && (
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="p-2 pt-0 space-y-2">
            {tasks.length === 0 ? (
              <div className="py-3 text-center text-xs text-muted-foreground/60">{config?.emptyMessage || 'No tasks'}</div>
            ) : tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />)}
          </div>
        </SortableContext>
      )}
    </div>
  );
}
