/**
 * Integration tests for subprocess spawning (detached process architecture)
 * Tests AgentManager spawning detached Python processes correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { findPythonCommand, parsePythonCommand } from '../../main/python-detector';

// Test directories
const TEST_DIR = '/tmp/subprocess-spawn-test';
const TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');

// Detect the Python command that will actually be used
const DETECTED_PYTHON_CMD = findPythonCommand() || 'python';
const [, ] = parsePythonCommand(DETECTED_PYTHON_CMD);

// Mock child_process spawn (still used by some legacy code paths)
const mockStdout = new EventEmitter();
const mockStderr = new EventEmitter();
const mockProcess = Object.assign(new EventEmitter(), {
  stdout: mockStdout,
  stderr: mockStderr,
  pid: 12345,
  killed: false,
  kill: vi.fn(() => {
    mockProcess.killed = true;
    return true;
  })
});

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProcess)
}));

// Mock spawnAgentProcess for detached process spawning
const mockSpawnAgentProcess = vi.fn((_options: unknown) => ({
  pid: 12345,
  outputFile: '/tmp/test-output.log'
}));

vi.mock('../../main/agent/agent-process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawnAgentProcess: (options: unknown) => mockSpawnAgentProcess(options)
  };
});

// Mock claude-profile-manager to bypass auth checks in tests
vi.mock('../../main/claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({
    hasValidAuth: () => true,
    getActiveProfile: () => ({ profileId: 'default', profileName: 'Default' })
  })
}));

// Mock agent-registry
const mockRegistryEntry = {
  specId: 'test-spec',
  pid: 12345,
  executionId: 'exec-123',
  status: 'running' as const,
  outputFile: '/tmp/test-output.log',
  workingDirectory: TEST_PROJECT_PATH,
  startedAt: new Date().toISOString()
};

const mockRegistry = {
  get: vi.fn(() => mockRegistryEntry),
  getAll: vi.fn(() => ({})),
  getRunningAgents: vi.fn(() => []),
  isAgentAlive: vi.fn(() => ({ alive: false, reason: 'Process not running' })),
  cleanupStaleEntry: vi.fn(() => ({ success: true, lockfileDeleted: true })),
  updatePartial: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  checkHeartbeat: vi.fn(() => ({ status: 'healthy' }))
};

vi.mock('../../main/agent/agent-registry', () => ({
  getAgentRegistry: () => mockRegistry,
  readHeartbeat: vi.fn(() => ({ success: false }))
}));

// Mock file-output-streamer
const mockStreamer = Object.assign(new EventEmitter(), {
  start: vi.fn(),
  stop: vi.fn(),
  triggerRead: vi.fn(),
  getIsActive: vi.fn(() => false)
});

vi.mock('../../main/agent/file-output-streamer', () => ({
  createFileOutputStreamer: vi.fn(() => mockStreamer),
  FileOutputStreamer: vi.fn()
}));

// Mock rate-limit-detector for getProfileEnv
vi.mock('../../main/rate-limit-detector', () => ({
  getProfileEnv: vi.fn(() => ({})),
  detectRateLimit: vi.fn(() => ({ isRateLimited: false })),
  detectAuthFailure: vi.fn(() => ({ isAuthFailure: false })),
  createSDKRateLimitInfo: vi.fn()
}));

// Auto-claude source path (for getAutoBuildSourcePath to find)
const AUTO_CLAUDE_SOURCE = path.join(TEST_DIR, 'auto-claude-source');

// Setup test directories
function setupTestDirs(): void {
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });

  // Create auto-claude source directory that getAutoBuildSourcePath looks for
  mkdirSync(AUTO_CLAUDE_SOURCE, { recursive: true });

  // Create requirements.txt file (used as marker by getAutoBuildSourcePath)
  writeFileSync(path.join(AUTO_CLAUDE_SOURCE, 'requirements.txt'), '# Mock requirements');

  // Create runners subdirectory (where spec_runner.py lives after restructure)
  mkdirSync(path.join(AUTO_CLAUDE_SOURCE, 'runners'), { recursive: true });

  // Create mock spec_runner.py in runners/ subdirectory
  writeFileSync(
    path.join(AUTO_CLAUDE_SOURCE, 'runners', 'spec_runner.py'),
    '# Mock spec runner\nprint("Starting spec creation")'
  );
  // Create mock run.py
  writeFileSync(
    path.join(AUTO_CLAUDE_SOURCE, 'run.py'),
    '# Mock run.py\nprint("Starting task execution")'
  );
}

// Cleanup test directories
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('Subprocess Spawn Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.killed = false;
    mockSpawnAgentProcess.mockClear();
    mockStreamer.start.mockClear();
    mockStreamer.stop.mockClear();
    mockStreamer.removeAllListeners();
    mockRegistry.get.mockClear();
    mockRegistry.isAgentAlive.mockClear();
    mockRegistry.cleanupStaleEntry.mockClear();
    cleanupTestDirs();
    setupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  describe('Python Command Detection', () => {
    it('should detect an available Python command', () => {
      const cmd = findPythonCommand();
      // At least one Python should be available (or null if none)
      expect(cmd === null || typeof cmd === 'string').toBe(true);
    });

    it('should parse Python command correctly', () => {
      // Simple command
      expect(parsePythonCommand('python')).toEqual(['python', []]);
      expect(parsePythonCommand('python3')).toEqual(['python3', []]);

      // Command with arguments (like "py -3")
      expect(parsePythonCommand('py -3')).toEqual(['py', ['-3']]);
      expect(parsePythonCommand('python -u')).toEqual(['python', ['-u']]);
    });
  });

  describe('AgentManager', () => {
    it('should spawn detached process for spec creation', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test task description');

      // Should call spawnAgentProcess with correct args
      expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          specId: 'task-1', // For spec creation, specId = taskId
          command: expect.any(String),
          args: expect.arrayContaining([
            expect.stringContaining('spec_runner.py')
          ]),
          cwd: TEST_PROJECT_PATH
        })
      );
    });

    it('should spawn detached process for task execution', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startTaskExecution('task-1', TEST_PROJECT_PATH, 'spec-001');

      // Should call spawnAgentProcess with correct args
      expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          specId: 'spec-001', // For task execution, specId is from param
          command: expect.any(String),
          args: expect.arrayContaining([
            expect.stringContaining('run.py'),
            '--spec',
            'spec-001'
          ]),
          cwd: TEST_PROJECT_PATH
        })
      );
    });

    it('should spawn detached process for QA process', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startQAProcess('task-1', TEST_PROJECT_PATH, 'spec-001');

      expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          specId: 'spec-001',
          args: expect.arrayContaining([
            '--spec',
            'spec-001',
            '--qa'
          ])
        })
      );
    });

    it('should emit log events when file streamer emits lines', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      const logHandler = vi.fn();
      manager.on('log', logHandler);

      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test');

      // Simulate log output from file streamer
      mockStreamer.emit('line', 'Test log output');

      expect(logHandler).toHaveBeenCalledWith('task-1', 'Test log output\n');
    });

    it('should track running tasks via reconnectedAgents', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      expect(manager.getRunningTasks()).toHaveLength(0);

      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test 1');
      expect(manager.getRunningTasks()).toContain('task-1');

      manager.startTaskExecution('task-2', TEST_PROJECT_PATH, 'spec-001');
      expect(manager.getRunningTasks()).toHaveLength(2);
    });

    it('should report task as running after starting', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);

      expect(manager.isRunning('task-1')).toBe(false);

      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test');

      expect(manager.isRunning('task-1')).toBe(true);
    });

    it('should return false for non-existent task', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      const result = manager.killTask('non-existent');

      expect(result).toBe(false);
    });

    it('should emit start event when process is spawned', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      const startHandler = vi.fn();
      manager.on('start', startHandler);

      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test');

      expect(startHandler).toHaveBeenCalledWith('task-1', 'spec-creation');
    });

    it('should emit execution-progress event on start', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      const progressHandler = vi.fn();
      manager.on('execution-progress', progressHandler);

      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test');

      expect(progressHandler).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          phase: 'planning',
          phaseProgress: 0,
          overallProgress: expect.any(Number)
        })
      );
    });

    it('should kill all running tasks', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test 1');
      manager.startTaskExecution('task-2', TEST_PROJECT_PATH, 'spec-001');

      // Mock isAgentAlive to return false (process not running)
      mockRegistry.isAgentAlive.mockReturnValue({ alive: false, reason: 'Process not running' });

      await manager.killAll();

      // Should have cleaned up - tasks removed from tracking
      expect(manager.getRunningTasks()).toHaveLength(0);
    });

    it('should disconnect from agent when starting new one for same task', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test 1');

      // Start another process for same task
      manager.startSpecCreation('task-1', TEST_PROJECT_PATH, 'Test 2');

      // Should have called spawnAgentProcess twice
      expect(mockSpawnAgentProcess).toHaveBeenCalledTimes(2);

      // Should only have one running task (replaced the first)
      expect(manager.getRunningTasks()).toContain('task-1');
      expect(manager.getRunningTasks()).toHaveLength(1);
    });

    it('should accept parallel options without affecting spawn args', async () => {
      const { AgentManager } = await import('../../main/agent');

      const manager = new AgentManager();
      manager.configure(undefined, AUTO_CLAUDE_SOURCE);
      manager.startTaskExecution('task-1', TEST_PROJECT_PATH, 'spec-001', {
        parallel: true,
        workers: 4
      });

      // Should spawn normally - parallel options don't affect CLI args anymore
      expect(mockSpawnAgentProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          specId: 'spec-001',
          args: expect.arrayContaining([
            expect.stringContaining('run.py'),
            '--spec',
            'spec-001'
          ])
        })
      );
    });
  });
});
