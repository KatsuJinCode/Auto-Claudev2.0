const fs = require('fs');
const path = 'src/renderer/__tests__/task-store.test.ts';
let content = fs.readFileSync(path, 'utf-8');

// Normalize line endings for matching
const normalizedContent = content.replace(/\r\n/g, '\n');

const oldCode = `      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
    });

    it('should update title from plan feature', () => {`;

const newCode = `      expect(useTaskStore.getState().tasks[0].status).toBe('in_progress');
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

    it('should update title from plan feature', () => {`;

if (normalizedContent.includes(oldCode)) {
  let newContent = normalizedContent.replace(oldCode, newCode);
  newContent = newContent.replace(/\n/g, '\r\n');
  fs.writeFileSync(path, newContent);
  console.log('SUCCESS: Added test for done status preservation');
} else {
  console.log('ERROR: Could not find exact code to replace');
}
