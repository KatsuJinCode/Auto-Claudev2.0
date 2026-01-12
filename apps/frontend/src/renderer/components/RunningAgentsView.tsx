import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, X, ChevronDown, Play, Square, AlertTriangle, CheckCircle2, Loader2, Copy, Trash2, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import { useTaskStore, isActivityRecent } from '../stores/task-store';
import type { TaskStatus } from '../../shared/types';

/** Maximum lines to display in memory to prevent performance issues */
const MAX_DISPLAY_LINES = 5000;

interface RunningAgentsViewProps {
  projectPath?: string;
}

/**
 * Get status icon and color for a task
 */
function getStatusIndicator(status: TaskStatus, isRecent: boolean) {
  switch (status) {
    case 'in_progress':
      return {
        icon: isRecent ? Loader2 : AlertTriangle,
        color: isRecent ? 'text-blue-500' : 'text-yellow-500',
        animate: isRecent,
        label: isRecent ? 'Running' : 'Stalled'
      };
    case 'ai_review':
      return {
        icon: Loader2,
        color: 'text-purple-500',
        animate: true,
        label: 'QA Review'
      };
    case 'human_review':
      return {
        icon: CheckCircle2,
        color: 'text-green-500',
        animate: false,
        label: 'Review'
      };
    case 'done':
      return {
        icon: CheckCircle2,
        color: 'text-green-500',
        animate: false,
        label: 'Complete'
      };
    case 'blocked':
      return {
        icon: AlertTriangle,
        color: 'text-red-500',
        animate: false,
        label: 'Blocked'
      };
    default:
      return {
        icon: Square,
        color: 'text-muted-foreground',
        animate: false,
        label: status
      };
  }
}

export function RunningAgentsView({ projectPath }: RunningAgentsViewProps) {
  const tasks = useTaskStore((state) => state.tasks);
  const logActivity = useTaskStore((state) => state.logActivity);
  const clearTaskLogs = useTaskStore((state) => state.clearTaskLogs);

  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const outputRef = useRef<HTMLDivElement>(null);

  // Filter to running/active agents (in_progress or ai_review)
  const runningAgents = useMemo(() => {
    return tasks.filter((task) =>
      task.status === 'in_progress' ||
      task.status === 'ai_review'
    );
  }, [tasks]);

  // Also show recently completed/blocked for context
  const recentAgents = useMemo(() => {
    return tasks.filter((task) =>
      (task.status === 'done' || task.status === 'human_review' || task.status === 'blocked') &&
      task.logs && task.logs.length > 0
    ).slice(0, 5); // Last 5 completed/finished
  }, [tasks]);

  // Combine running and recent
  const allAgents = useMemo(() => {
    return [...runningAgents, ...recentAgents];
  }, [runningAgents, recentAgents]);

  // Set active agent to first running agent if none selected
  useEffect(() => {
    if (!activeAgentId && runningAgents.length > 0) {
      setActiveAgentId(runningAgents[0].id);
    }
  }, [activeAgentId, runningAgents]);

  // Get the active agent's data
  const activeAgent = useMemo(() => {
    return allAgents.find((t) => t.id === activeAgentId);
  }, [allAgents, activeAgentId]);

  // Get logs with buffer limit applied
  const bufferedLogs = useMemo(() => {
    if (!activeAgent?.logs) return [];
    const logs = activeAgent.logs;
    // Only show last MAX_DISPLAY_LINES to prevent memory issues
    if (logs.length > MAX_DISPLAY_LINES) {
      return logs.slice(-MAX_DISPLAY_LINES);
    }
    return logs;
  }, [activeAgent?.logs]);

  // Track if logs were truncated
  const logsTruncated = useMemo(() => {
    return (activeAgent?.logs?.length || 0) > MAX_DISPLAY_LINES;
  }, [activeAgent?.logs?.length]);

  // Filter logs based on search query
  const filteredLogs = useMemo(() => {
    if (!searchQuery) return bufferedLogs;

    const query = searchQuery.toLowerCase();
    return bufferedLogs.filter((log) =>
      log.toLowerCase().includes(query)
    );
  }, [bufferedLogs, searchQuery]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  // Handle scroll to detect if user manually scrolled up
  const handleScroll = () => {
    if (!outputRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  };

  const handleClearLogs = useCallback(() => {
    if (activeAgentId && clearTaskLogs) {
      clearTaskLogs(activeAgentId);
    }
  }, [activeAgentId, clearTaskLogs]);

  const handleCopyOutput = useCallback(async () => {
    const textToCopy = filteredLogs.join('\n');
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [filteredLogs]);

  const handleScrollToBottom = () => {
    setAutoScroll(true);
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  };

  // Check if agent is actively receiving logs
  const isAgentActive = (taskId: string) => {
    const activity = logActivity.get(taskId);
    return activity ? isActivityRecent(activity.lastLogTimestamp) : false;
  };

  if (allAgents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Play className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">No Running Agents</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Start a task to see live agent output here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tabs for each agent */}
      <div className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-1">
          {allAgents.map((agent) => {
            const activity = logActivity.get(agent.id);
            const isRecent = activity ? isActivityRecent(activity.lastLogTimestamp) : false;
            const indicator = getStatusIndicator(agent.status, isRecent);
            const Icon = indicator.icon;

            return (
              <button
                key={agent.id}
                onClick={() => setActiveAgentId(agent.id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                  'hover:bg-accent',
                  activeAgentId === agent.id && 'bg-accent'
                )}
              >
                <Icon
                  className={cn(
                    'h-3.5 w-3.5',
                    indicator.color,
                    indicator.animate && 'animate-spin'
                  )}
                />
                <span className="max-w-[150px] truncate">
                  {agent.title || agent.specId}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search output..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopyOutput}
          disabled={filteredLogs.length === 0}
          title="Copy output to clipboard"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearLogs}
          disabled={!activeAgent?.logs?.length}
          title="Clear output display"
        >
          <Trash2 className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleScrollToBottom}
          className={cn(!autoScroll && 'text-blue-500')}
          title={autoScroll ? 'Auto-scroll enabled' : 'Click to enable auto-scroll'}
        >
          <ChevronDown className="h-4 w-4" />
          {!autoScroll && <span className="ml-1">Auto-scroll</span>}
        </Button>
      </div>

      {/* Truncation warning */}
      {logsTruncated && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-3 py-1 text-xs text-yellow-600 dark:text-yellow-400">
          Showing last {MAX_DISPLAY_LINES.toLocaleString()} lines. Full log available in file.
        </div>
      )}

      {/* Output display */}
      <div
        ref={outputRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto bg-zinc-950 p-3 font-mono text-xs select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {searchQuery ? 'No matching logs' : 'Waiting for output...'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredLogs.map((log, index) => (
              <LogLine key={index} log={log} searchQuery={searchQuery} />
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      {activeAgent && (
        <div className="flex items-center justify-between border-t border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            {(() => {
              const isRecent = isAgentActive(activeAgent.id);
              const indicator = getStatusIndicator(activeAgent.status, isRecent);
              const Icon = indicator.icon;
              return (
                <>
                  <Icon className={cn('h-3 w-3', indicator.color, indicator.animate && 'animate-spin')} />
                  <span>{indicator.label}</span>
                </>
              );
            })()}
          </div>
          <div className="flex items-center gap-3">
            {logsTruncated && (
              <span className="text-yellow-600 dark:text-yellow-400">
                {(activeAgent.logs?.length || 0).toLocaleString()} total
              </span>
            )}
            <span>
              {filteredLogs.length.toLocaleString()} lines
              {searchQuery && ` (filtered)`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Export hook to get running agent count for badges
 */
export function useRunningAgentCount(): number {
  const tasks = useTaskStore((state) => state.tasks);
  return useMemo(() => {
    return tasks.filter((task) =>
      task.status === 'in_progress' ||
      task.status === 'ai_review'
    ).length;
  }, [tasks]);
}

/**
 * Individual log line with syntax highlighting
 */
function LogLine({ log, searchQuery }: { log: string; searchQuery: string }) {
  // Determine line type for coloring
  const getLineClass = () => {
    const lower = log.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal') || lower.includes('failed')) {
      return 'text-red-400';
    }
    if (lower.includes('warning') || lower.includes('warn')) {
      return 'text-yellow-400';
    }
    if (lower.includes('success') || lower.includes('completed') || lower.includes('✓')) {
      return 'text-green-400';
    }
    if (lower.includes('===') || lower.includes('---')) {
      return 'text-blue-400 font-semibold';
    }
    if (log.startsWith('[') && log.includes(']')) {
      return 'text-zinc-300';
    }
    return 'text-zinc-400';
  };

  // Highlight search matches
  if (searchQuery) {
    const parts = log.split(new RegExp(`(${searchQuery})`, 'gi'));
    return (
      <div className={cn('whitespace-pre-wrap break-all', getLineClass())}>
        {parts.map((part, i) =>
          part.toLowerCase() === searchQuery.toLowerCase() ? (
            <span key={i} className="bg-yellow-500/30 text-yellow-200">{part}</span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </div>
    );
  }

  return (
    <div className={cn('whitespace-pre-wrap break-all', getLineClass())}>
      {log}
    </div>
  );
}
