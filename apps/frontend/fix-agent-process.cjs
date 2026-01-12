const fs = require('fs');
const path = 'apps/frontend/src/main/agent/agent-process.ts';
let content = fs.readFileSync(path, 'utf-8');

// Find and remove the conflict section
// Pattern: from "<<<<<<< HEAD" through ">>>>>>> auto-claude/004-ui-state-reliability"
// But preserve the JSDoc comment that wraps around it

// The structure is:
//   /**
//   <<<<<<< HEAD
//   =======
//   ... 004's duplicate spawnProcess code ...
//   /**
//   >>>>>>> auto-claude/004-ui-state-reliability
//      * Kill a specific task's process
//      */

// We want to keep just:
//   /**
//      * Kill a specific task's process
//      */

const conflictRegex = /  \/\*\*\r?\n<<<<<<< HEAD\r?\n=======[\s\S]*?\/\*\*\r?\n>>>>>>> auto-claude\/004-ui-state-reliability\r?\n/;

if (conflictRegex.test(content)) {
  content = content.replace(conflictRegex, '  /**\n');
  fs.writeFileSync(path, content);
  console.log('SUCCESS: Resolved conflict in agent-process.ts');
} else {
  console.log('ERROR: Could not find conflict pattern');
  // Debug
  console.log('Looking for <<<<<<:', content.includes('<<<<<<'));
  console.log('Looking for >>>>>>>:', content.includes('>>>>>>>'));
}
