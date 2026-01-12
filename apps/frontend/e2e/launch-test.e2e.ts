/**
 * Minimal test to verify Electron app launches
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('should launch Electron app and take screenshot', async () => {
  // Ensure screenshots directory exists
  mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });

  // Launch the app
  const appPath = path.join(__dirname, '..');
  console.log('Launching app from:', appPath);

  const app = await electron.launch({
    args: [appPath],
    timeout: 30000
  });

  // Get the first window
  const page = await app.firstWindow();
  console.log('Got first window');

  // Wait for content to load
  await page.waitForLoadState('domcontentloaded');
  console.log('DOM content loaded');

  // Take a screenshot
  const screenshotPath = path.join(__dirname, 'screenshots', `launch-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot saved to:', screenshotPath);

  // Keep the app open - wait for a long time
  console.log('App is open. Waiting 5 minutes for inspection...');
  await page.waitForTimeout(300000); // 5 minutes

  // Close the app
  await app.close();
  console.log('App closed');
});
