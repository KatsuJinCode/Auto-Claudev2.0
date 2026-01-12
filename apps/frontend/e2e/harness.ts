/**
 * E2E Test Harness - File-based command interface
 *
 * Commands are written to: e2e/command.json
 * Results are written to: e2e/result.json
 *
 * Command format: { "id": 1, "action": "screenshot", "args": ["name"] }
 * Result format: { "id": 1, "success": true, "data": "path/to/file.png" }
 */
import { _electron as electron, ElectronApplication, Page } from 'playwright';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, watchFile } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const COMMAND_FILE = path.join(__dirname, 'command.json');
const RESULT_FILE = path.join(__dirname, 'result.json');

interface Command {
  id: number;
  action: string;
  args?: string[];
}

interface Result {
  id: number;
  success: boolean;
  data?: string;
  error?: string;
}

let app: ElectronApplication;
let page: Page;
let lastCommandId = 0;

function writeResult(result: Result) {
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(`Result written: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.data || result.error}`);
}

async function executeCommand(cmd: Command): Promise<void> {
  console.log(`Executing command ${cmd.id}: ${cmd.action} ${cmd.args?.join(' ') || ''}`);

  try {
    switch (cmd.action) {
      case 'screenshot': {
        const name = cmd.args?.[0] || `screenshot-${cmd.id}`;
        const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
        await page.screenshot({ path: filepath, fullPage: true });
        writeResult({ id: cmd.id, success: true, data: filepath });
        break;
      }

      case 'click': {
        const selector = cmd.args?.join(' ') || '';
        await page.click(selector, { timeout: 5000 });
        writeResult({ id: cmd.id, success: true, data: `Clicked: ${selector}` });
        break;
      }

      case 'clickText': {
        const text = cmd.args?.join(' ') || '';
        await page.locator(`text=${text}`).first().click({ timeout: 5000 });
        writeResult({ id: cmd.id, success: true, data: `Clicked text: ${text}` });
        break;
      }

      case 'type': {
        const text = cmd.args?.join(' ') || '';
        await page.keyboard.type(text);
        writeResult({ id: cmd.id, success: true, data: `Typed: ${text}` });
        break;
      }

      case 'press': {
        const key = cmd.args?.[0] || '';
        await page.keyboard.press(key);
        writeResult({ id: cmd.id, success: true, data: `Pressed: ${key}` });
        break;
      }

      case 'title': {
        const title = await page.title();
        writeResult({ id: cmd.id, success: true, data: title });
        break;
      }

      case 'url': {
        const url = page.url();
        writeResult({ id: cmd.id, success: true, data: url });
        break;
      }

      case 'waitFor': {
        const selector = cmd.args?.join(' ') || '';
        await page.waitForSelector(selector, { timeout: 10000 });
        writeResult({ id: cmd.id, success: true, data: `Found: ${selector}` });
        break;
      }

      case 'getText': {
        const selector = cmd.args?.join(' ') || '';
        const text = await page.locator(selector).first().textContent();
        writeResult({ id: cmd.id, success: true, data: text || '' });
        break;
      }

      case 'scroll': {
        const direction = cmd.args?.[0] || 'down';
        const amount = parseInt(cmd.args?.[1] || '300', 10);
        await page.mouse.wheel(0, direction === 'down' ? amount : -amount);
        writeResult({ id: cmd.id, success: true, data: `Scrolled ${direction} ${amount}px` });
        break;
      }

      case 'quit': {
        writeResult({ id: cmd.id, success: true, data: 'Closing app' });
        await app.close();
        process.exit(0);
        break; // Unreachable but satisfies linter
      }

      default:
        writeResult({ id: cmd.id, success: false, error: `Unknown action: ${cmd.action}` });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    writeResult({ id: cmd.id, success: false, error: errorMsg });
  }
}

function checkForCommand() {
  if (!existsSync(COMMAND_FILE)) return;

  try {
    const content = readFileSync(COMMAND_FILE, 'utf-8');
    if (!content.trim()) return;

    const cmd: Command = JSON.parse(content);

    // Skip if we already processed this command
    if (cmd.id <= lastCommandId) return;

    lastCommandId = cmd.id;
    executeCommand(cmd);
  } catch (err) {
    // Ignore parse errors - file might be mid-write
  }
}

async function getMainWindow(electronApp: ElectronApplication): Promise<Page> {
  await new Promise(r => setTimeout(r, 2000));

  const allWindows = electronApp.windows();
  for (const w of allWindows) {
    const url = w.url();
    if (!url.startsWith('devtools://')) {
      return w;
    }
  }

  return electronApp.firstWindow();
}

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Clear old command/result files
  if (existsSync(COMMAND_FILE)) writeFileSync(COMMAND_FILE, '');
  if (existsSync(RESULT_FILE)) writeFileSync(RESULT_FILE, '');

  const appPath = path.join(__dirname, '..');
  console.log('Launching app from:', appPath);

  app = await electron.launch({
    args: [appPath],
    timeout: 30000
  });

  page = await getMainWindow(app);
  await page.waitForLoadState('domcontentloaded');

  // Close DevTools automatically
  console.log('Closing DevTools...');
  await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      }
    }
  });
  console.log('DevTools closed');

  // Move to secondary monitor and maximize
  console.log('Moving to secondary monitor...');
  const displayInfo = await app.evaluate(({ BrowserWindow, screen }) => {
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();

    // Find secondary display (any display that's not primary)
    const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id);
    const targetDisplay = secondaryDisplay || primaryDisplay;

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      // Move window to target display
      const { x, y, width, height } = targetDisplay.workArea;
      win.setBounds({ x, y, width, height });
      win.maximize();
    }

    return {
      totalDisplays: displays.length,
      usingSecondary: !!secondaryDisplay,
      targetBounds: targetDisplay.workArea
    };
  });
  console.log(`Displays: ${displayInfo.totalDisplays}, Using secondary: ${displayInfo.usingSecondary}`);

  const title = await page.title();
  console.log('App launched, window title:', title);
  console.log('');
  console.log('=== HARNESS READY ===');
  console.log(`Write commands to: ${COMMAND_FILE}`);
  console.log(`Read results from: ${RESULT_FILE}`);
  console.log('');
  console.log('Available commands:');
  console.log('  screenshot [name]     - Take a screenshot');
  console.log('  click [selector]      - Click an element');
  console.log('  clickText [text]      - Click element containing text');
  console.log('  type [text]           - Type text');
  console.log('  press [key]           - Press a key (Enter, Tab, etc)');
  console.log('  title                 - Get window title');
  console.log('  url                   - Get current URL');
  console.log('  waitFor [selector]    - Wait for element');
  console.log('  getText [selector]    - Get text content');
  console.log('  scroll [up|down] [px] - Scroll the page');
  console.log('  quit                  - Close app and exit');
  console.log('');

  // Poll for commands every 500ms
  setInterval(checkForCommand, 500);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
