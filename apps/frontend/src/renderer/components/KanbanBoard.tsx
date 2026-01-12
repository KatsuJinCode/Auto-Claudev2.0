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

interface DroppableColumnProps {
  columnId: KanbanColumnId;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  onAddClick?: () => void;
  onArchiveAll?: () => void;
  collapsedSubsections: Record<QueueSubsection, boolean>;
  onToggleSubsection: (subsection: QueueSubsection) => void;
  overSubsection?: string | null;
}

function DroppableColumn({ columnId, tasks, onTaskClick, isOver, onAddClick, onArchiveAll, collapsedSubsections, onToggleSubsection, overSubsection }: DroppableColumnProps) {
  const { setNodeRef } = useDroppable({ id: columnId });
  const config = KANBAN_COLUMN_CONFIG[columnId];
  const taskIds = tasks.map((t) => t.id);

  const queueSubsectionTasks = useMemo(() => {
    if (columnId !== 'queue') return null;
    return {
      unstarted: tasks.filter(t => categorizeQueueTask(t) === 'unstarted'),
      blocked: tasks.filter(t => categorizeQueueTask(t) === 'blocked'),
      failed: tasks.filter(t => categorizeQueueTask(t) === 'failed')
    };
  }, [columnId, tasks]);

  const getEmptyIcon = () => {
    switch (config.emptyIcon) {
      case 'Inbox': return <Inbox className="h-6 w-6 text-muted-foreground/50" />;
      case 'Loader2': return <Loader2 className="h-6 w-6 text-muted-foreground/50" />;
      case 'Eye': return <Eye className="h-6 w-6 text-muted-foreground/50" />;
      case 'CheckCircle2': return <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />;
      default: return <Inbox className="h-6 w-6 text-muted-foreground/50" />;
    }
  };

  return (
    <div ref={setNodeRef} className={cn('flex min-w-56 flex-1 flex-col rounded-xl border border-white/5 bg-linear-to-b from-secondary/30 to-transparent backdrop-blur-sm transition-all duration-200', config.borderClass, 'border-t-2', isOver && !overSubsection && 'drop-zone-highlight')}>
      <div className="flex items-center justify-between p-4 border-b border-white/5">
        <div className="flex items-center gap-2.5">
          <h2 className="font-semibold text-sm text-foreground">{config.label}</h2>
          <span className="column-count-badge">{tasks.length}</span>
        </div>
        <div className="flex items-center gap-1">
          {columnId === 'queue' && onAddClick && (
            <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-primary/10 hover:text-primary transition-colors" onClick={onAddClick}>
              <Plus className="h-4 w-4" />
            </Button>
          )}
          {columnId === 'done' && onArchiveAll && tasks.length > 0 && (
            <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-muted-foreground/10 hover:text-muted-foreground transition-colors" onClick={onArchiveAll} title="Archive all done tasks">
              <Archive className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full px-3 pb-3 pt-2">
          {columnId === 'queue' && queueSubsectionTasks ? (
            <div className="space-y-3 min-h-[120px]">
              {QUEUE_SUBSECTIONS.map((subsectionConfig) => (
                <QueueSubsectionComponent
                  key={subsectionConfig.id}
                  subsection={subsectionConfig.id}
                  tasks={queueSubsectionTasks[subsectionConfig.id]}
                  onTaskClick={onTaskClick}
                  isOver={overSubsection === `queue-${subsectionConfig.id}`}
                  isCollapsed={collapsedSubsections[subsectionConfig.id]}
                  onToggle={() => onToggleSubsection(subsectionConfig.id)}
                />
              ))}
            </div>
          ) : (
            <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-3 min-h-[120px]">
                {tasks.length === 0 ? (
                  <div className={cn('empty-column-dropzone flex flex-col items-center justify-center py-6', isOver && 'active')}>
                    {isOver ? (
                      <>
                        <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center mb-2">
                          <Plus className="h-4 w-4 text-primary" />
                        </div>
                        <span className="text-sm font-medium text-primary">Drop here</span>
                      </>
                    ) : (
                      <>
                        {getEmptyIcon()}
                        <span className="mt-2 text-sm font-medium text-muted-foreground/70">{config.emptyMessage}</span>
                        <span className="mt-0.5 text-xs text-muted-foreground/50">{config.emptySubtext}</span>
                      </>
                    )}
                  </div>
                ) : tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />)}
              </div>
            </SortableContext>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

export function KanbanBoard({ tasks, onTaskClick, onNewTaskClick, onRefreshClick }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [overSubsection, setOverSubsection] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedSubsections, setCollapsedSubsections] = useState<Record<QueueSubsection, boolean>>({
    unstarted: false, blocked: false, failed: false
  });

  const archivedCount = useMemo(() => tasks.filter((t) => t.metadata?.archivedAt).length, [tasks]);
  const filteredTasks = useMemo(() => showArchived ? tasks : tasks.filter((t) => !t.metadata?.archivedAt), [tasks, showArchived]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const tasksByColumn = useMemo(() => {
    const grouped: Record<KanbanColumnId, Task[]> = { queue: [], in_progress: [], review: [], done: [] };
    filteredTasks.forEach((task) => { grouped[getKanbanColumn(task)].push(task); });
    return grouped;
  }, [filteredTasks]);

  const handleArchiveAll = async () => {
    const projectId = tasks[0]?.projectId;
    if (!projectId) return;
    const doneTaskIds = tasksByColumn.done.map((t) => t.id);
    if (doneTaskIds.length === 0) return;
    await archiveTasks(projectId, doneTaskIds);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverColumnId(null); setOverSubsection(null); return; }
    const overId = over.id as string;
    if (overId.startsWith('queue-')) { setOverColumnId('queue'); setOverSubsection(overId); return; }
    if (KANBAN_COLUMNS.includes(overId as KanbanColumnId)) { setOverColumnId(overId); setOverSubsection(null); return; }
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      const column = getKanbanColumn(overTask);
      setOverColumnId(column);
      setOverSubsection(column === 'queue' ? `queue-${categorizeQueueTask(overTask)}` : null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null); setOverColumnId(null); setOverSubsection(null);
    if (!over) return;
    const activeTaskId = active.id as string;
    const overId = over.id as string;
    const task = tasks.find((t) => t.id === activeTaskId);
    if (!task) return;
    if (overId.startsWith('queue-')) {
      const subsection = overId.replace('queue-', '') as QueueSubsection;
      const newStatus = columnToStatus('queue', subsection);
      if (task.status !== newStatus) persistTaskStatus(activeTaskId, newStatus);
      return;
    }
    if (KANBAN_COLUMNS.includes(overId as KanbanColumnId)) {
      const newStatus = columnToStatus(overId as KanbanColumnId);
      if (task.status !== newStatus) persistTaskStatus(activeTaskId, newStatus);
      return;
    }
    const overTask = tasks.find((t) => t.id === overId);
    if (overTask) {
      const overColumn = getKanbanColumn(overTask);
      const newStatus = overColumn === 'queue' ? columnToStatus('queue', categorizeQueueTask(overTask)) : columnToStatus(overColumn);
      if (task.status !== newStatus) persistTaskStatus(activeTaskId, newStatus);
    }
  };

  const handleToggleSubsection = (subsection: QueueSubsection) => {
    setCollapsedSubsections(prev => ({ ...prev, [subsection]: !prev[subsection] }));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border/50">
        {onRefreshClick && (
          <Button variant="ghost" size="sm" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground" onClick={onRefreshClick}>
            <RefreshCw className="h-4 w-4" />
            Refresh Tasks
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Checkbox id="showArchived" checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />
          <Label htmlFor="showArchived" className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <Archive className="h-3.5 w-3.5" />
            Show archived
            {archivedCount > 0 && <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted">{archivedCount}</span>}
          </Label>
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-4 overflow-x-auto p-6">
          {KANBAN_COLUMNS.map((columnId) => (
            <DroppableColumn
              key={columnId}
              columnId={columnId}
              tasks={tasksByColumn[columnId]}
              onTaskClick={onTaskClick}
              isOver={overColumnId === columnId}
              onAddClick={columnId === 'queue' ? onNewTaskClick : undefined}
              onArchiveAll={columnId === 'done' ? handleArchiveAll : undefined}
              collapsedSubsections={collapsedSubsections}
              onToggleSubsection={handleToggleSubsection}
              overSubsection={overSubsection}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? <div className="drag-overlay-card"><TaskCard task={activeTask} onClick={() => {}} /></div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
