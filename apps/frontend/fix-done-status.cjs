const fs = require('fs');
const path = 'src/renderer/stores/task-store.ts';
let content = fs.readFileSync(path, 'utf-8');

// The file uses CRLF line endings, normalize to LF for matching
const normalizedContent = content.replace(/\r\n/g, '\n');

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

if (normalizedContent.includes(oldCode)) {
  // Replace in normalized content, then convert back to CRLF
  let newContent = normalizedContent.replace(oldCode, newCode);
  newContent = newContent.replace(/\n/g, '\r\n');
  fs.writeFileSync(path, newContent);
  console.log('SUCCESS: Updated updateTaskFromPlan to preserve done status');
} else {
  console.log('ERROR: Could not find exact code to replace');
}
