import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskCard } from './TaskCard';
import { cn } from '../lib/utils';
import type { Task } from '../../shared/types';

interface SortableTaskCardProps {
  task: Task;
  onClick: () => void;
}

export function SortableTaskCard({ task, onClick }: SortableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Add z-index to ensure dragging card is above others
    zIndex: isDragging ? 10 : undefined
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'touch-none transition-all duration-150',
        // When being dragged - show placeholder state
        isDragging && 'opacity-40 scale-[0.98] ring-2 ring-dashed ring-primary/30 rounded-xl',
        // When another card is over this one - show drop indicator
        isOver && !isDragging && 'ring-2 ring-primary/50 rounded-xl'
      )}
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} onClick={onClick} />
    </div>
  );
}
