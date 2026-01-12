const fs = require('fs');

const kanbanPath = 'src/renderer/components/KanbanBoard.tsx';
let content = fs.readFileSync(kanbanPath, 'utf-8');
content = content.replace(/\r\n/g, '\n');

// 1. Add Rows icon import for compact toggle
content = content.replace(
  "import { Plus, Inbox, Loader2, Eye, CheckCircle2, Archive, RefreshCw, ChevronDown, ChevronRight, Ban, AlertTriangle } from 'lucide-react';",
  "import { Plus, Inbox, Loader2, Eye, CheckCircle2, Archive, RefreshCw, ChevronDown, ChevronRight, Ban, AlertTriangle, LayoutGrid, LayoutList } from 'lucide-react';"
);

// 2. Update QueueSubsectionProps to include compact
content = content.replace(
  `interface QueueSubsectionProps {
  subsection: QueueSubsection;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
}`,
  `interface QueueSubsectionProps {
  subsection: QueueSubsection;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  compactCards?: boolean;
}`
);

// 3. Update QueueSubsectionComponent signature and SortableTaskCard usage
content = content.replace(
  'function QueueSubsectionComponent({ subsection, tasks, onTaskClick, isOver, isCollapsed, onToggle }: QueueSubsectionProps) {',
  'function QueueSubsectionComponent({ subsection, tasks, onTaskClick, isOver, isCollapsed, onToggle, compactCards }: QueueSubsectionProps) {'
);

content = content.replace(
  `: tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />)}`,
  `: tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} compact={compactCards} />)}`
);

// 4. Update DroppableColumnProps to include compactCards
content = content.replace(
  `interface DroppableColumnProps {
  columnId: KanbanColumnId;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  onAddClick?: () => void;
  onArchiveAll?: () => void;
  collapsedSubsections: Record<QueueSubsection, boolean>;
  onToggleSubsection: (subsection: QueueSubsection) => void;
  overSubsection?: string | null;
}`,
  `interface DroppableColumnProps {
  columnId: KanbanColumnId;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isOver: boolean;
  onAddClick?: () => void;
  onArchiveAll?: () => void;
  collapsedSubsections: Record<QueueSubsection, boolean>;
  onToggleSubsection: (subsection: QueueSubsection) => void;
  overSubsection?: string | null;
  compactCards?: boolean;
}`
);

// 5. Update DroppableColumn signature
content = content.replace(
  'function DroppableColumn({ columnId, tasks, onTaskClick, isOver, onAddClick, onArchiveAll, collapsedSubsections, onToggleSubsection, overSubsection }: DroppableColumnProps) {',
  'function DroppableColumn({ columnId, tasks, onTaskClick, isOver, onAddClick, onArchiveAll, collapsedSubsections, onToggleSubsection, overSubsection, compactCards }: DroppableColumnProps) {'
);

// 6. Update QueueSubsectionComponent call to pass compactCards
content = content.replace(
  `<QueueSubsectionComponent
                  key={subsectionConfig.id}
                  subsection={subsectionConfig.id}
                  tasks={queueSubsectionTasks[subsectionConfig.id]}
                  onTaskClick={onTaskClick}
                  isOver={overSubsection === \`queue-\${subsectionConfig.id}\`}
                  isCollapsed={collapsedSubsections[subsectionConfig.id]}
                  onToggle={() => onToggleSubsection(subsectionConfig.id)}
                />`,
  `<QueueSubsectionComponent
                  key={subsectionConfig.id}
                  subsection={subsectionConfig.id}
                  tasks={queueSubsectionTasks[subsectionConfig.id]}
                  onTaskClick={onTaskClick}
                  isOver={overSubsection === \`queue-\${subsectionConfig.id}\`}
                  isCollapsed={collapsedSubsections[subsectionConfig.id]}
                  onToggle={() => onToggleSubsection(subsectionConfig.id)}
                  compactCards={compactCards}
                />`
);

// 7. Update non-queue SortableTaskCard usage in DroppableColumn
content = content.replace(
  `: tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} />)}
              </div>
            </SortableContext>`,
  `: tasks.map((task) => <SortableTaskCard key={task.id} task={task} onClick={() => onTaskClick(task)} compact={compactCards} />)}
              </div>
            </SortableContext>`
);

// 8. Add compactCards state in KanbanBoard component
content = content.replace(
  `const [showArchived, setShowArchived] = useState(false);`,
  `const [showArchived, setShowArchived] = useState(false);
  const [compactCards, setCompactCards] = useState(false);`
);

// 9. Add compact toggle in the header next to "Show archived"
content = content.replace(
  `<div className="flex items-center gap-2">
          <Checkbox id="showArchived" checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />
          <Label htmlFor="showArchived" className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <Archive className="h-3.5 w-3.5" />
            Show archived
            {archivedCount > 0 && <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted">{archivedCount}</span>}
          </Label>
        </div>`,
  `<div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant={compactCards ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={() => setCompactCards(!compactCards)}
              title={compactCards ? 'Switch to expanded view' : 'Switch to compact view'}
            >
              {compactCards ? <LayoutGrid className="h-4 w-4" /> : <LayoutList className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="showArchived" checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />
            <Label htmlFor="showArchived" className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
              <Archive className="h-3.5 w-3.5" />
              Show archived
              {archivedCount > 0 && <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted">{archivedCount}</span>}
            </Label>
          </div>
        </div>`
);

// 10. Pass compactCards to DroppableColumn
content = content.replace(
  `<DroppableColumn
              key={columnId}
              columnId={columnId}
              tasks={tasksByColumn[columnId]}
              onTaskClick={onTaskClick}
              isOver={overColumnId === columnId}
              onAddClick={columnId === 'queue' ? onNewTaskClick : undefined}`,
  `<DroppableColumn
              key={columnId}
              columnId={columnId}
              tasks={tasksByColumn[columnId]}
              onTaskClick={onTaskClick}
              isOver={overColumnId === columnId}
              onAddClick={columnId === 'queue' ? onNewTaskClick : undefined}
              compactCards={compactCards}`
);

// Convert back to CRLF and save
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(kanbanPath, content);
console.log('SUCCESS: Updated KanbanBoard with compact cards toggle');
