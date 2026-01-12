const fs = require('fs');
const path = 'src/renderer/stores/task-store.ts';
let content = fs.readFileSync(path, 'utf-8');

const oldCode = `  updateTaskFromPlan: (taskId, plan) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== taskId && t.specId !== taskId) return t;

        // Extract subtasks from plan`;

const newCode = `  updateTaskFromPlan: (taskId, plan) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== taskId && t.specId !== taskId) return t;

        // CRITICAL: Once a task is marked 'done' by human review, NEVER auto-change status
        // This prevents stale plan updates from moving tasks out of Done column
        if (t.status === 'done') {
          // Still update subtasks and title, but preserve 'done' status
          const subtasks: Subtask[] = plan.phases.flatMap((phase) =>
            phase.subtasks.map((subtask) => ({
              id: subtask.id,
              title: subtask.description,
              description: subtask.description,
              status: subtask.status,
              files: [],
              verification: subtask.verification as Subtask['verification']
            }))
          );
          return {
            ...t,
            title: plan.feature || t.title,
            subtasks,
            updatedAt: new Date()
          };
        }

        // Extract subtasks from plan`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(path, content);
  console.log('SUCCESS: Updated updateTaskFromPlan to preserve done status');
} else {
  console.log('ERROR: Could not find exact code to replace');
  // Debug: show what's around line 63-70
  const lines = content.split('\n');
  console.log('Lines 63-70:');
  for (let i = 62; i < 70 && i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
