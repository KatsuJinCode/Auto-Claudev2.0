/**
 * Unit tests for Task Store
 * Tests Zustand store for task state management
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useTaskStore,
  parseTimestamp,
  validateTimestamp,
  LOG_ACTIVITY_DEBOUNCE_MS,
  CLOCK_SKEW_TOLERANCE_MS
} from '../stores/task-store';
import type { Task, TaskStatus, ImplementationPlan } from '../../shared/types';

// Helper to create test tasks
function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    specId: 'test-spec-001',
    projectId: 'project-1',
    title: 'Test Task',
    description: 'Test description',
    status: 'backlog' as TaskStatus,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

// Helper to create test implementation plan
function createTestPlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  return {
    feature: 'Test Feature',
    workflow_type: 'feature',
    services_involved: [],
    phases: [
      {
        phase: 1,
        name: 'Test Phase',
        type: 'implementation',
        subtasks: [
          { id: 'subtask-1', description: 'First subtask', status: 'pending' },
          { id: 'subtask-2', description: 'Second subtask', status: 'pending' }
        ]
      }
    ],
    final_acceptance: ['Tests pass'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    spec_file: 'spec.md',
    ...overrides
  };
}

describe('Task Store', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useTaskStore.setState({
      tasks: [],
      selectedTaskId: null,
      isLoading: false,
      error: null,
      logActivity: new Map()
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('setTasks', () => {
    it('should set tasks array', () => {
      const tasks = [createTestTask({ id: 'task-1' }), createTestTask({ id: 'task-2' })];

      useTaskStore.getState().setTasks(tasks);

      expect(useTaskStore.getState().tasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].id).toBe('task-1');
    });

    it('should replace existing tasks', () => {
      const initialTasks = [createTestTask({ id: 'old-task' })];
      const newTasks = [createTestTask({ id: 'new-task' })];

      useTaskStore.getState().setTasks(initialTasks);
      useTaskStore.getState().setTasks(newTasks);

      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().tasks[0].id).toBe('new-task');
    });

    it('should handle empty array', () => {
      useTaskStore.getState().setTasks([createTestTask()]);
      useTaskStore.getState().setTasks([]);

      expect(useTaskStore.getState().tasks).toHaveLength(0);
    });
  });

  describe('addTask', () => {
    it('should add task to empty array', () => {
      const task = createTestTask({ id: 'new-task' });

      useTaskStore.getState().addTask(task);

      expect(useTaskStore.getState().tasks).toHaveLength(1);
      expect(useTaskStore.getState().tasks[0].id).toBe('new-task');
    });

    it('should append task to existing array', () => {
      useTaskStore.setState({ tasks: [createTestTask({ id: 'existing' })] });

      useTaskStore.getState().addTask(createTestTask({ id: 'new-task' }));

      expect(useTaskStore.getState().tasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[1].id).toBe('new-task');
    });
  });

  describe('updateTask', () => {
    it('should update task by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original Title' })]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated Title' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated Title');
    });

    it('should update task by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', title: 'Original' })]
      });

      useTaskStore.getState().updateTask('spec-001', { title: 'Updated via specId' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated via specId');
    });

    it('should not modify other tasks', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Task 1' }),
          createTestTask({ id: 'task-2', title: 'Task 2' })
        ]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated Task 1' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated Task 1');
      expect(useTaskStore.getState().tasks[1].title).toBe('Task 2');
    });

    it('should merge updates with existing task', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original', description: 'Original Desc' })]
      });

      useTaskStore.getState().updateTask('task-1', { title: 'Updated' });

      expect(useTaskStore.getState().tasks[0].title).toBe('Updated');
      expect(useTaskStore.getState().tasks[0].description).toBe('Original Desc');
    });
  });

  describe('updateTaskStatus', () => {
    it('should update task status by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'backlog' })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
    });

    it('should update task status by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', status: 'backlog' })]
      });

      useTaskStore.getState().updateTaskStatus('spec-001', 'done');

      expect(useTaskStore.getState().tasks[0].status).toBe('done');
    });

    it('should update updatedAt timestamp', () => {
      const originalDate = new Date('2024-01-01');
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', updatedAt: originalDate })]
      });

      useTaskStore.getState().updateTaskStatus('task-1', 'in_progress');

      expect(useTaskStore.getState().tasks[0].updatedAt.getTime()).toBeGreaterThan(
        originalDate.getTime()
      );
    });
  });

  describe('updateTaskFromPlan', () => {
    it('should extract subtasks from plan', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', subtasks: [] })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', description: 'Subtask 1', status: 'completed' },
              { id: 'c2', description: 'Subtask 2', status: 'pending' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].subtasks[0].id).toBe('c1');
      expect(useTaskStore.getState().tasks[0].subtasks[0].status).toBe('completed');
    });

    it('should extract subtasks from multiple phases', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [{ id: 'c1', description: 'Subtask 1', status: 'completed' }]
          },
          {
            phase: 2,
            name: 'Phase 2',
            type: 'cleanup',
            subtasks: [{ id: 'c2', description: 'Subtask 2', status: 'pending' }]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(2);
    });

    it('should update status to ai_review when all subtasks completed', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', description: 'Subtask 1', status: 'completed' },
              { id: 'c2', description: 'Subtask 2', status: 'completed' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].status).toBe('ai_review');
    });

    it('should update status to human_review when any subtask failed', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'in_progress' })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', description: 'Subtask 1', status: 'completed' },
              { id: 'c2', description: 'Subtask 2', status: 'failed' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].status).toBe('human_review');
    });

    it('should update status to in_progress when some subtasks in progress', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'backlog' })]
      });

      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', description: 'Subtask 1', status: 'completed' },
              { id: 'c2', description: 'Subtask 2', status: 'in_progress' }
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
    });

    it('should NEVER change status when task is already done', () => {
      // CRITICAL: Once a human approves a task (done status), it should never
      // automatically change back to any other status, even if plan data suggests otherwise
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', status: 'done' })]
      });

      // Even with incomplete subtasks, done status should be preserved
      const plan = createTestPlan({
        phases: [
          {
            phase: 1,
            name: 'Phase 1',
            type: 'implementation',
            subtasks: [
              { id: 'c1', description: 'Subtask 1', status: 'completed' },
              { id: 'c2', description: 'Subtask 2', status: 'in_progress' } // would normally trigger in_progress
            ]
          }
        ]
      });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      // Status must remain 'done'
      expect(useTaskStore.getState().tasks[0].status).toBe('done');
      // But subtasks should still be updated
      expect(useTaskStore.getState().tasks[0].subtasks).toHaveLength(2);
    });

    it('should update title from plan feature', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', title: 'Original Title' })]
      });

      const plan = createTestPlan({ feature: 'New Feature Name' });

      useTaskStore.getState().updateTaskFromPlan('task-1', plan);

      expect(useTaskStore.getState().tasks[0].title).toBe('New Feature Name');
    });
  });

  describe('appendLog', () => {
    it('should append log to task by id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', logs: [] })]
      });

      useTaskStore.getState().appendLog('task-1', 'First log');
      useTaskStore.getState().appendLog('task-1', 'Second log');

      expect(useTaskStore.getState().tasks[0].logs).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].logs[0]).toBe('First log');
      expect(useTaskStore.getState().tasks[0].logs[1]).toBe('Second log');
    });

    it('should append log to task by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001', logs: [] })]
      });

      useTaskStore.getState().appendLog('spec-001', 'Log message');

      expect(useTaskStore.getState().tasks[0].logs).toContain('Log message');
    });

    it('should accumulate logs correctly', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', logs: ['existing log'] })]
      });

      useTaskStore.getState().appendLog('task-1', 'new log');

      expect(useTaskStore.getState().tasks[0].logs).toHaveLength(2);
      expect(useTaskStore.getState().tasks[0].logs[0]).toBe('existing log');
      expect(useTaskStore.getState().tasks[0].logs[1]).toBe('new log');
    });
  });

  describe('selectTask', () => {
    it('should set selected task id', () => {
      useTaskStore.getState().selectTask('task-1');

      expect(useTaskStore.getState().selectedTaskId).toBe('task-1');
    });

    it('should clear selection with null', () => {
      useTaskStore.setState({ selectedTaskId: 'task-1' });

      useTaskStore.getState().selectTask(null);

      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });

  describe('setLoading', () => {
    it('should set loading state to true', () => {
      useTaskStore.getState().setLoading(true);

      expect(useTaskStore.getState().isLoading).toBe(true);
    });

    it('should set loading state to false', () => {
      useTaskStore.setState({ isLoading: true });

      useTaskStore.getState().setLoading(false);

      expect(useTaskStore.getState().isLoading).toBe(false);
    });
  });

  describe('setError', () => {
    it('should set error message', () => {
      useTaskStore.getState().setError('Something went wrong');

      expect(useTaskStore.getState().error).toBe('Something went wrong');
    });

    it('should clear error with null', () => {
      useTaskStore.setState({ error: 'Previous error' });

      useTaskStore.getState().setError(null);

      expect(useTaskStore.getState().error).toBeNull();
    });
  });

  describe('clearTasks', () => {
    it('should clear all tasks and selection', () => {
      useTaskStore.setState({
        tasks: [createTestTask(), createTestTask()],
        selectedTaskId: 'task-1'
      });

      useTaskStore.getState().clearTasks();

      expect(useTaskStore.getState().tasks).toHaveLength(0);
      expect(useTaskStore.getState().selectedTaskId).toBeNull();
    });
  });

  describe('getSelectedTask', () => {
    it('should return undefined when no task selected', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })],
        selectedTaskId: null
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeUndefined();
    });

    it('should return selected task', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', title: 'Task 1' }),
          createTestTask({ id: 'task-2', title: 'Task 2' })
        ],
        selectedTaskId: 'task-2'
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeDefined();
      expect(selected?.title).toBe('Task 2');
    });

    it('should return undefined for non-existent selected id', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })],
        selectedTaskId: 'nonexistent'
      });

      const selected = useTaskStore.getState().getSelectedTask();

      expect(selected).toBeUndefined();
    });
  });

  describe('getTasksByStatus', () => {
    it('should return empty array when no tasks match status', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ status: 'backlog' })]
      });

      const tasks = useTaskStore.getState().getTasksByStatus('in_progress');

      expect(tasks).toHaveLength(0);
    });

    it('should return all tasks with matching status', () => {
      useTaskStore.setState({
        tasks: [
          createTestTask({ id: 'task-1', status: 'in_progress' }),
          createTestTask({ id: 'task-2', status: 'backlog' }),
          createTestTask({ id: 'task-3', status: 'in_progress' })
        ]
      });

      const tasks = useTaskStore.getState().getTasksByStatus('in_progress');

      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id)).toContain('task-1');
      expect(tasks.map((t) => t.id)).toContain('task-3');
    });

    it('should filter by each status type', () => {
      const statuses: TaskStatus[] = ['backlog', 'in_progress', 'ai_review', 'human_review', 'done'];

      useTaskStore.setState({
        tasks: statuses.map((status) => createTestTask({ id: `task-${status}`, status }))
      });

      statuses.forEach((status) => {
        const tasks = useTaskStore.getState().getTasksByStatus(status);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].status).toBe(status);
      });
    });
  });

  describe('reconcileTaskState', () => {
    it('should update execution progress for a task', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        phaseProgress: 50,
        overallProgress: 25
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.executionProgress?.phaseProgress).toBe(50);
      expect(task.executionProgress?.overallProgress).toBe(25);
    });

    it('should update execution progress by specId', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', specId: 'spec-001' })]
      });

      useTaskStore.getState().reconcileTaskState('spec-001', {
        phase: 'planning',
        phaseProgress: 75
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('planning');
      expect(task.executionProgress?.phaseProgress).toBe(75);
    });

    it('should update log activity when timestamp is provided as Date', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const timestamp = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Working on feature',
        timestamp
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity).toBeDefined();
      expect(activity?.lastLogTimestamp.getTime()).toBe(timestamp.getTime());
      expect(activity?.lastActivityLog).toBe('Working on feature');
    });

    it('should update log activity when timestamp is provided as ISO string', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const timestamp = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        currentSubtask: 'subtask-1',
        timestamp: timestamp.toISOString()
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity).toBeDefined();
      expect(activity?.lastLogTimestamp.getTime()).toBe(timestamp.getTime());
      expect(activity?.lastActivityLog).toBe('subtask-1');
    });

    it('should not update log activity when timestamp is invalid', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        timestamp: 'invalid-date' as unknown as Date
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity).toBeUndefined();
    });

    it('should reject timestamps more than 5 minutes in the future (clock skew)', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const futureTimestamp = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes in future
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        timestamp: futureTimestamp
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity).toBeUndefined();
    });

    it('should accept timestamps within 5 minutes in the future', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const nearFutureTimestamp = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes in future
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Future activity',
        timestamp: nearFutureTimestamp
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity).toBeDefined();
      expect(activity?.lastLogTimestamp.getTime()).toBe(nearFutureTimestamp.getTime());
    });

    it('should merge with existing execution progress', () => {
      useTaskStore.setState({
        tasks: [createTestTask({
          id: 'task-1',
          executionProgress: {
            phase: 'planning',
            phaseProgress: 100,
            overallProgress: 20,
            startedAt: new Date('2024-01-01')
          }
        })]
      });

      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        phaseProgress: 0
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.executionProgress?.phase).toBe('coding');
      expect(task.executionProgress?.phaseProgress).toBe(0);
      expect(task.executionProgress?.overallProgress).toBe(20); // Preserved
      expect(task.executionProgress?.startedAt).toEqual(new Date('2024-01-01')); // Preserved
    });

    it('should not modify state for non-existent task', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const initialState = useTaskStore.getState();
      useTaskStore.getState().reconcileTaskState('non-existent', {
        phase: 'coding'
      });

      expect(useTaskStore.getState().tasks).toEqual(initialState.tasks);
    });

    it('should use phase name when no message or currentSubtask provided', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const timestamp = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'qa_review',
        timestamp
      });

      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity?.lastActivityLog).toBe('Phase: qa_review');
    });

    it('should update task updatedAt timestamp', () => {
      const oldDate = new Date('2024-01-01');
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1', updatedAt: oldDate })]
      });

      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding'
      });

      const task = useTaskStore.getState().tasks[0];
      expect(task.updatedAt.getTime()).toBeGreaterThan(oldDate.getTime());
    });

    it('should track activity as recent when timestamp is new', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        timestamp: new Date() // Now
      });

      expect(useTaskStore.getState().getIsTaskActivityRecent('task-1')).toBe(true);
    });

    it('should track activity as stale when timestamp is old', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        timestamp: oldTimestamp
      });

      expect(useTaskStore.getState().getIsTaskActivityRecent('task-1')).toBe(false);
    });

    it('should fallback to previous timestamp when parsing fails', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      // First, set a valid timestamp
      const validTimestamp = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Initial activity',
        timestamp: validTimestamp
      });

      // Verify initial state
      const initialActivity = useTaskStore.getState().getLogActivity('task-1');
      expect(initialActivity?.lastLogTimestamp.getTime()).toBe(validTimestamp.getTime());

      // Now update with invalid timestamp - should keep previous
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'qa_review',
        message: 'QA activity',
        timestamp: 'invalid-timestamp' as unknown as Date
      });

      // Should keep the previous valid timestamp
      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity?.lastLogTimestamp.getTime()).toBe(validTimestamp.getTime());
      // But message should update
      expect(activity?.lastActivityLog).toBe('QA activity');
    });

    it('should debounce rapid updates when content unchanged', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const timestamp1 = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Same message',
        timestamp: timestamp1
      });

      const firstUpdate = useTaskStore.getState().getLogActivity('task-1')?.localUpdatedAt;
      expect(firstUpdate).toBeDefined();

      // Rapid update with same content - should be debounced
      const timestamp2 = new Date(Date.now() + 100); // 100ms later
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Same message',
        timestamp: timestamp2
      });

      // localUpdatedAt should not change due to debounce
      const secondUpdate = useTaskStore.getState().getLogActivity('task-1')?.localUpdatedAt;
      expect(secondUpdate?.getTime()).toBe(firstUpdate?.getTime());
    });

    it('should update despite debounce when content changes', () => {
      useTaskStore.setState({
        tasks: [createTestTask({ id: 'task-1' })]
      });

      const timestamp1 = new Date();
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'First message',
        timestamp: timestamp1
      });

      const firstUpdate = useTaskStore.getState().getLogActivity('task-1')?.localUpdatedAt;
      expect(firstUpdate).toBeDefined();

      // Rapid update with DIFFERENT content - should NOT be debounced
      const timestamp2 = new Date(Date.now() + 100); // 100ms later
      useTaskStore.getState().reconcileTaskState('task-1', {
        phase: 'coding',
        message: 'Different message',
        timestamp: timestamp2
      });

      // Message should be updated even though within debounce window
      const activity = useTaskStore.getState().getLogActivity('task-1');
      expect(activity?.lastActivityLog).toBe('Different message');
    });
  });

  describe('parseTimestamp', () => {
    it('should parse valid Date object', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      expect(parseTimestamp(date)).toEqual(date);
    });

    it('should parse valid ISO string', () => {
      const isoString = '2024-01-01T00:00:00.000Z';
      const result = parseTimestamp(isoString);
      expect(result).toBeInstanceOf(Date);
      expect(result?.toISOString()).toBe(isoString);
    });

    it('should parse epoch milliseconds', () => {
      const epoch = 1704067200000; // 2024-01-01T00:00:00Z
      const result = parseTimestamp(epoch);
      expect(result).toBeInstanceOf(Date);
      expect(result?.getTime()).toBe(epoch);
    });

    it('should return undefined for null', () => {
      expect(parseTimestamp(null)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(parseTimestamp(undefined)).toBeUndefined();
    });

    it('should return undefined for invalid date string', () => {
      expect(parseTimestamp('not-a-date')).toBeUndefined();
    });

    it('should return undefined for Invalid Date object', () => {
      expect(parseTimestamp(new Date('invalid'))).toBeUndefined();
    });
  });

  describe('validateTimestamp', () => {
    it('should return valid timestamp', () => {
      const timestamp = new Date();
      expect(validateTimestamp(timestamp)).toEqual(timestamp);
    });

    it('should return undefined for null', () => {
      expect(validateTimestamp(undefined)).toBeUndefined();
    });

    it('should return undefined for Invalid Date', () => {
      expect(validateTimestamp(new Date('invalid'))).toBeUndefined();
    });

    it('should reject timestamp beyond clock skew tolerance', () => {
      const future = new Date(Date.now() + CLOCK_SKEW_TOLERANCE_MS + 60000);
      expect(validateTimestamp(future)).toBeUndefined();
    });

    it('should accept timestamp within clock skew tolerance', () => {
      const nearFuture = new Date(Date.now() + CLOCK_SKEW_TOLERANCE_MS - 1000);
      expect(validateTimestamp(nearFuture)).toBeDefined();
    });

    it('should accept past timestamps', () => {
      const past = new Date(Date.now() - 60000);
      expect(validateTimestamp(past)).toEqual(past);
    });
  });
});
