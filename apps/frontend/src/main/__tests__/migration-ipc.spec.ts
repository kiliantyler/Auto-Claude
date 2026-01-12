/**
 * Integration tests for Migration IPC handlers
 * Tests IPC communication flow: main sends progress updates → renderer receives → store updates
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Test data directory
const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'migration-ipc-test-'));
const TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');

// Mock electron before importing
vi.mock('electron', () => {
  const mockIpcMain = new (class extends EventEmitter {
    private handlers: Map<string, Function> = new Map();

    handle(channel: string, handler: Function): void {
      this.handlers.set(channel, handler);
    }

    removeHandler(channel: string): void {
      this.handlers.delete(channel);
    }

    async invokeHandler(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
      const handler = this.handlers.get(channel);
      if (handler) {
        return handler(event, ...args);
      }
      throw new Error(`No handler for channel: ${channel}`);
    }

    getHandler(channel: string): Function | undefined {
      return this.handlers.get(channel);
    }
  })();

  return {
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'userData') return path.join(TEST_DIR, 'userData');
        return TEST_DIR;
      }),
      getAppPath: vi.fn(() => TEST_DIR),
      getVersion: vi.fn(() => '0.1.0'),
      isPackaged: false
    },
    ipcMain: mockIpcMain,
    BrowserWindow: class {
      webContents = { send: vi.fn() };
    }
  };
});

// Mock electron-log to prevent Electron binary dependency
vi.mock('electron-log/main.js', () => ({
  default: {
    initialize: vi.fn(),
    transports: {
      file: {
        maxSize: 10 * 1024 * 1024,
        format: '',
        fileName: 'main.log',
        level: 'info',
        getFile: vi.fn(() => ({ path: '/tmp/test.log' }))
      },
      console: {
        level: 'warn',
        format: ''
      }
    },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

// Setup test project structure
function setupTestProject(): void {
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
  mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });
}

// Create test JSON files
function createTestJsonFiles(): void {
  const autoClaude = path.join(TEST_PROJECT_PATH, '.auto-claude');

  // tasks.json
  const tasks = [
    {
      id: 'task-1',
      specId: 'spec-1',
      projectId: 'project-1',
      title: 'Test Task',
      description: 'Test Description',
      status: 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {}
    }
  ];
  writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify(tasks, null, 2));

  // implementation_plan.json
  writeFileSync(
    path.join(autoClaude, 'implementation_plan.json'),
    JSON.stringify({ version: '1.0.0' }, null, 2)
  );

  // task_logs.json
  writeFileSync(
    path.join(autoClaude, 'task_logs.json'),
    JSON.stringify([], null, 2)
  );
}

// Cleanup test directories
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Increase timeout for all tests in this file
describe('Migration IPC Handlers', { timeout: 15000 }, () => {
  let ipcMain: EventEmitter & {
    handlers: Map<string, Function>;
    invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
    getHandler: (channel: string) => Function | undefined;
  };
  let mockMainWindow: { webContents: { send: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    cleanupTestDirs();
    setupTestProject();
    mkdirSync(path.join(TEST_DIR, 'userData'), { recursive: true });

    // Get mocked ipcMain
    const electron = await import('electron');
    ipcMain = electron.ipcMain as unknown as typeof ipcMain;

    // Create mock window
    const { BrowserWindow } = electron;
    mockMainWindow = new BrowserWindow() as unknown as typeof mockMainWindow;

    // Clear any existing handlers
    const channels = ['migration:start', 'migration:status', 'migration:progress'];
    channels.forEach((channel) => ipcMain.removeHandler(channel));

    // Register migration handlers
    const { registerMigrationHandlers } = await import('../ipc-handlers/migration-handlers');
    registerMigrationHandlers(() => mockMainWindow as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('migration:start', () => {
    it('should start migration and emit progress updates', async () => {
      createTestJsonFiles();

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // Invoke migration:start handler
      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);

      // Verify handler returned success
      expect(result).toEqual({ success: true });

      // Verify progress updates were sent to renderer
      expect(mockMainWindow.webContents.send).toHaveBeenCalled();

      // Check that migration:progress was called with expected structure
      const progressCalls = (mockMainWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'migration:progress'
      );

      expect(progressCalls.length).toBeGreaterThan(0);

      // Verify progress event structure
      const firstProgress = progressCalls[0][1];
      expect(firstProgress).toMatchObject({
        projectPath: TEST_PROJECT_PATH,
        status: expect.stringMatching(/running|completed/),
        percentage: expect.any(Number),
        filesCompleted: expect.any(Number),
        totalFiles: 3
      });

      // Verify final progress is completed
      const lastProgress = progressCalls[progressCalls.length - 1][1];
      expect(lastProgress).toMatchObject({
        projectPath: TEST_PROJECT_PATH,
        status: 'completed',
        percentage: 100,
        filesCompleted: expect.any(Number),
        totalFiles: 3
      });

      // Verify migration marker was created
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(true);
    });

    it('should return error when project path is missing', async () => {
      // Invoke handler without project path
      const result = await ipcMain.invokeHandler('migration:start', {}, '');

      // Verify error response
      expect(result).toEqual({
        success: false,
        error: 'Project path is required'
      });

      // Verify no progress updates were sent
      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should handle migration errors gracefully', async () => {
      // Create corrupted JSON file
      mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });
      writeFileSync(
        path.join(TEST_PROJECT_PATH, '.auto-claude', 'tasks.json'),
        'invalid json content {'
      );

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // Invoke migration:start handler
      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);

      // Verify error response
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Failed to start migration')
      });

      // Verify rollback progress was sent
      const progressCalls = (mockMainWindow.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'migration:progress'
      );

      if (progressCalls.length > 0) {
        const lastProgress = progressCalls[progressCalls.length - 1][1];
        expect(lastProgress.status).toBe('rolled_back');
        expect(lastProgress.error).toBeDefined();
      }
    });

    it('should skip migration if already migrated', async () => {
      createTestJsonFiles();

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // First migration
      const result1 = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);
      expect(result1).toEqual({ success: true });

      // Clear mock to check second migration
      mockMainWindow.webContents.send = vi.fn();

      // Second migration (should skip)
      const result2 = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);
      expect(result2).toEqual({ success: true });

      // No progress updates should be sent (already migrated)
      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('migration:status', () => {
    it('should return migration status for migrated project', async () => {
      createTestJsonFiles();

      // Initialize database and run migration
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);

      // Get migration status
      const result = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_PATH);

      // Verify status response
      expect(result).toMatchObject({
        success: true,
        data: {
          hasMigrated: true,
          projectPath: TEST_PROJECT_PATH,
          migratedAt: expect.any(String),
          migratedFiles: expect.arrayContaining([
            'tasks.json',
            'implementation_plan.json',
            'task_logs.json'
          ]),
          version: '1.0.0'
        }
      });
    });

    it('should return status for non-migrated project', async () => {
      // Get migration status for non-migrated project
      const result = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_PATH);

      // Verify status response
      expect(result).toMatchObject({
        success: true,
        data: {
          hasMigrated: false,
          projectPath: TEST_PROJECT_PATH
        }
      });
    });

    it('should return error when project path is missing', async () => {
      // Invoke handler without project path
      const result = await ipcMain.invokeHandler('migration:status', {}, '');

      // Verify error response
      expect(result).toEqual({
        success: false,
        error: 'Project path is required'
      });
    });
  });

  describe('Progress event communication', () => {
    it('should emit progress events at regular intervals during migration', async () => {
      createTestJsonFiles();

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // Track progress events
      const progressEvents: unknown[] = [];
      mockMainWindow.webContents.send = vi.fn((channel, data) => {
        if (channel === 'migration:progress') {
          progressEvents.push(data);
        }
      });

      // Start migration
      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);

      // Verify multiple progress events were emitted
      expect(progressEvents.length).toBeGreaterThan(2); // At least: initial, per-file, completion

      // Verify progress percentages increase monotonically
      const percentages = progressEvents.map((e: any) => e.percentage);
      for (let i = 1; i < percentages.length; i++) {
        expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]);
      }

      // Verify files completed increases
      const filesCompleted = progressEvents.map((e: any) => e.filesCompleted);
      for (let i = 1; i < filesCompleted.length; i++) {
        expect(filesCompleted[i]).toBeGreaterThanOrEqual(filesCompleted[i - 1]);
      }
    });

    it('should include current file name in progress events', async () => {
      createTestJsonFiles();

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // Track progress events
      const progressEvents: unknown[] = [];
      mockMainWindow.webContents.send = vi.fn((channel, data) => {
        if (channel === 'migration:progress') {
          progressEvents.push(data);
        }
      });

      // Start migration
      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH);

      // Check that at least one event includes a current file
      const eventsWithFile = progressEvents.filter((e: any) => e.currentFile !== null);
      expect(eventsWithFile.length).toBeGreaterThan(0);

      // Verify file names are expected
      const fileNames = eventsWithFile.map((e: any) => e.currentFile);
      const expectedFiles = ['tasks.json', 'implementation_plan.json', 'task_logs.json'];

      fileNames.forEach((fileName: string) => {
        expect(expectedFiles).toContain(fileName);
      });
    });
  });

  describe('IPC channel registration', () => {
    it('should register all migration IPC channels', async () => {
      // Verify handlers are registered
      expect(ipcMain.getHandler('migration:start')).toBeDefined();
      expect(ipcMain.getHandler('migration:status')).toBeDefined();
    });

    it('should handle concurrent migration requests for different projects', async () => {
      // Create second test project
      const TEST_PROJECT_2 = path.join(TEST_DIR, 'test-project-2');
      mkdirSync(path.join(TEST_PROJECT_2, '.auto-claude'), { recursive: true });

      // Create test files for both projects
      createTestJsonFiles();

      const autoClaude2 = path.join(TEST_PROJECT_2, '.auto-claude');
      writeFileSync(path.join(autoClaude2, 'tasks.json'), JSON.stringify([], null, 2));
      writeFileSync(path.join(autoClaude2, 'implementation_plan.json'), JSON.stringify({}, null, 2));
      writeFileSync(path.join(autoClaude2, 'task_logs.json'), JSON.stringify([], null, 2));

      // Initialize database
      const { getDatabaseConnection } = await import('../database');
      const db = getDatabaseConnection();
      db.initialize();

      // Start migrations concurrently
      const [result1, result2] = await Promise.all([
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_PATH),
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_2)
      ]);

      // Both should succeed
      expect(result1).toEqual({ success: true });
      expect(result2).toEqual({ success: true });

      // Verify both projects are migrated
      const status1 = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_PATH);
      const status2 = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_2);

      expect((status1 as any).data.hasMigrated).toBe(true);
      expect((status2 as any).data.hasMigrated).toBe(true);
    });
  });
});
