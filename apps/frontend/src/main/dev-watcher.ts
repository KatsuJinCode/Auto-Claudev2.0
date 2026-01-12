/**
 * Development mode watcher for backend code changes
 *
 * Watches src/main/ directory and notifies renderer when changes are detected.
 * This allows the user to see when they need to reload the GUI to pick up
 * backend changes (agents survive the reload via detached process architecture).
 *
 * Only active in development mode.
 */
import chokidar, { FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { join, dirname } from 'path';
import { IPC_CHANNELS } from '../shared/constants';

let watcher: FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

/**
 * Start watching backend code for changes (dev mode only)
 */
export function startDevWatcher(mainWindow: BrowserWindow): void {
  // Get the src/main directory path
  // In dev, __dirname is out/main, so we need to go to actual source
  const srcMainDir = join(dirname(dirname(__dirname)), 'src', 'main');
  const srcPreloadDir = join(dirname(dirname(__dirname)), 'src', 'preload');
  const srcSharedDir = join(dirname(dirname(__dirname)), 'src', 'shared');

  console.log('[DevWatcher] Starting backend code watcher');
  console.log('[DevWatcher] Watching directories:', { srcMainDir, srcPreloadDir, srcSharedDir });

  watcher = chokidar.watch([srcMainDir, srcPreloadDir, srcSharedDir], {
    persistent: true,
    ignoreInitial: true,
    ignored: [
      '**/node_modules/**',
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/__tests__/**'
    ],
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  watcher.on('change', (filePath: string) => {
    console.log('[DevWatcher] Backend file changed:', filePath);

    // Debounce to avoid flooding with notifications
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[DevWatcher] Sending backend changed notification to renderer');
        mainWindow.webContents.send(IPC_CHANNELS.DEV_BACKEND_CHANGED, {
          file: filePath,
          timestamp: Date.now()
        });
      }
    }, 1000); // 1 second debounce
  });

  watcher.on('error', (error: unknown) => {
    console.error('[DevWatcher] Error:', error);
  });

  watcher.on('ready', () => {
    console.log('[DevWatcher] Ready and watching for backend changes');
  });
}

/**
 * Stop the dev watcher
 */
export async function stopDevWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (watcher) {
    await watcher.close();
    watcher = null;
    console.log('[DevWatcher] Stopped');
  }
}
