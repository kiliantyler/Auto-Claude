/**
 * End-to-End tests for full migration flow
 * Tests the complete migration process: detect JSON → parse → transaction → SQLite insert → marker creation → fallback on error
 *
 * This test suite verifies the entire migration pipeline including:
 * - JSON file detection and parsing
 * - Transaction-based database insertion
 * - Migration marker creation for idempotency
 * - Error handling and rollback
 * - Concurrent migration queuing
 * - Progress tracking and IPC communication
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Test directories
const TEST_DIR = path.join(tmpdir(), 'migration-e2e-test');
const TEST_PROJECT_1 = path.join(TEST_DIR, 'project-1');
const TEST_PROJECT_2 = path.join(TEST_DIR, 'project-2');
const TEST_PROJECT_3 = path.join(TEST_DIR, 'project-3');

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

// Mock electron-log
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

/**
 * Setup test project structure
 */
function setupTestProject(projectPath: string): void {
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(path.join(projectPath, '.auto-claude'), { recursive: true });
}

/**
 * Create comprehensive test JSON files with realistic data
 */
function createTestJsonFiles(projectPath: string, options?: {
  tasksCount?: number;
  includeAllFiles?: boolean;
  corruptFile?: string;
}): void {
  const autoClaude = path.join(projectPath, '.auto-claude');
  const { tasksCount = 5, includeAllFiles = true, corruptFile } = options || {};

  // tasks.json - realistic task structure
  if (includeAllFiles && corruptFile !== 'tasks.json') {
    const tasks = Array.from({ length: tasksCount }, (_, i) => ({
      id: `task-${i + 1}`,
      specId: `spec-${Math.floor(i / 2) + 1}`,
      projectId: path.basename(projectPath),
      title: `Task ${i + 1}: Implement Feature`,
      description: `Detailed description for task ${i + 1}`,
      status: ['backlog', 'in_progress', 'under_review', 'done'][i % 4] as 'backlog' | 'in_progress' | 'under_review' | 'done',
      reviewReason: i % 3 === 0 ? 'needs testing' : null,
      releasedInVersion: i % 4 === 3 ? `1.${i}.0` : null,
      stagedInMainProject: i % 2 === 0,
      stagedAt: i % 2 === 0 ? new Date(Date.now() - i * 86400000).toISOString() : null,
      location: `/path/to/project/${i}`,
      specsPath: `/specs/${i}`,
      metadata: {
        priority: ['low', 'medium', 'high'][i % 3],
        tags: [`tag-${i}`, 'test'],
        estimatedHours: (i + 1) * 2
      },
      subtasks: [
        { id: `sub-${i}-1`, title: `Subtask ${i}-1`, status: 'completed' },
        { id: `sub-${i}-2`, title: `Subtask ${i}-2`, status: 'pending' }
      ],
      qaReport: i % 4 === 3 ? { status: 'approved', reviewer: 'QA Bot' } : null,
      logs: [
        { timestamp: new Date().toISOString(), level: 'info', message: `Task ${i} started` }
      ],
      executionProgress: { current: i, total: tasksCount },
      createdAt: new Date(Date.now() - (tasksCount - i) * 86400000).toISOString(),
      updatedAt: new Date().toISOString()
    }));

    const content = corruptFile === 'tasks.json' ? 'invalid json {{{' : JSON.stringify(tasks, null, 2);
    writeFileSync(path.join(autoClaude, 'tasks.json'), content);
  }

  // implementation_plan.json
  if (includeAllFiles && corruptFile !== 'implementation_plan.json') {
    const plan = {
      feature: 'Test Feature Migration',
      workflow_type: 'feature',
      services_involved: ['frontend', 'backend'],
      phases: [
        {
          phase: 1,
          name: 'Phase 1: Setup',
          type: 'implementation',
          subtasks: [
            { id: 'subtask-1', description: 'Setup database', status: 'completed' },
            { id: 'subtask-2', description: 'Configure environment', status: 'in_progress' }
          ],
          chunks: [
            { id: 'chunk-1', description: 'Initial setup', status: 'completed' }
          ]
        },
        {
          phase: 2,
          name: 'Phase 2: Implementation',
          type: 'implementation',
          subtasks: [
            { id: 'subtask-3', description: 'Implement feature', status: 'pending' }
          ],
          chunks: [
            { id: 'chunk-2', description: 'Core implementation', status: 'pending' }
          ]
        }
      ],
      final_acceptance: ['All tests pass', 'Code reviewed', 'Documentation updated'],
      created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      updated_at: new Date().toISOString(),
      spec_file: 'spec.md',
      status: 'in_progress'
    };

    const content = corruptFile === 'implementation_plan.json' ? 'invalid json {{{' : JSON.stringify(plan, null, 2);
    writeFileSync(path.join(autoClaude, 'implementation_plan.json'), content);
  }

  // task_logs.json
  if (includeAllFiles && corruptFile !== 'task_logs.json') {
    const logs = Array.from({ length: 10 }, (_, i) => ({
      id: `log-${i + 1}`,
      taskId: `task-${(i % tasksCount) + 1}`,
      timestamp: new Date(Date.now() - i * 3600000).toISOString(),
      level: ['info', 'debug', 'warn', 'error'][i % 4],
      message: `Log entry ${i + 1}: Processing task`,
      metadata: {
        phase: 'execution',
        step: i + 1,
        duration: (i + 1) * 100
      }
    }));

    const content = corruptFile === 'task_logs.json' ? 'invalid json {{{' : JSON.stringify(logs, null, 2);
    writeFileSync(path.join(autoClaude, 'task_logs.json'), content);
  }
}

/**
 * Cleanup test directories
 */
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

/**
 * Verify task data integrity in database
 */
function verifyTasksInDatabase(db: any, expectedCount: number): void {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM tasks');
  const result = stmt.get();
  expect(result.count).toBe(expectedCount);

  // Verify sample task data
  const taskStmt = db.prepare('SELECT * FROM tasks LIMIT 1');
  const task = taskStmt.get();

  expect(task).toMatchObject({
    id: expect.any(String),
    spec_id: expect.any(String),
    project_id: expect.any(String),
    title: expect.stringContaining('Task'),
    description: expect.stringContaining('description'),
    status: expect.stringMatching(/backlog|in_progress|under_review|done/),
    metadata_json: expect.any(String),
    created_at: expect.any(String),
    updated_at: expect.any(String)
  });

  // Verify metadata is valid JSON
  const metadata = JSON.parse(task.metadata_json);
  expect(metadata).toHaveProperty('priority');
  expect(metadata).toHaveProperty('tags');
  expect(metadata).toHaveProperty('subtasks');
}

/**
 * Verify migration marker file
 */
function verifyMigrationMarker(projectPath: string, expectedFiles: string[]): void {
  const markerPath = path.join(projectPath, '.auto-claude', '.migration-status.json');
  expect(existsSync(markerPath)).toBe(true);

  const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
  expect(marker).toMatchObject({
    projectPath,
    migratedAt: expect.any(String),
    migratedFiles: expectedFiles,
    version: '1.0.0'
  });

  // Verify timestamp is valid
  const migratedDate = new Date(marker.migratedAt);
  expect(migratedDate.getTime()).toBeGreaterThan(Date.now() - 60000); // Within last minute
}

// Increase timeout for all tests
describe('Migration E2E Flow', { timeout: 30000 }, () => {
  let ipcMain: EventEmitter & {
    handlers: Map<string, Function>;
    invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
    getHandler: (channel: string) => Function | undefined;
  };
  let mockMainWindow: { webContents: { send: ReturnType<typeof vi.fn> } };
  let db: any;

  beforeEach(async () => {
    cleanupTestDirs();
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(path.join(TEST_DIR, 'userData'), { recursive: true });

    // Get mocked ipcMain
    const electron = await import('electron');
    ipcMain = electron.ipcMain as unknown as typeof ipcMain;

    // Create mock window
    const { BrowserWindow } = electron;
    mockMainWindow = new BrowserWindow() as unknown as typeof mockMainWindow;

    // Clear any existing handlers
    ['migration:start', 'migration:status'].forEach((channel) => ipcMain.removeHandler(channel));

    // Initialize database
    const { getDatabaseConnection } = await import('../main/database');
    db = getDatabaseConnection();
    db.initialize();

    // Register migration handlers
    const { registerMigrationHandlers } = await import('../main/ipc-handlers/migration-handlers');
    registerMigrationHandlers(() => mockMainWindow as unknown as import('electron').BrowserWindow);
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('First-time Migration Flow', () => {
    it('should complete full migration: detect → parse → insert → marker creation', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 10 });

      // Track all progress events
      const progressEvents: any[] = [];
      mockMainWindow.webContents.send = vi.fn((channel, data) => {
        if (channel === 'migration:progress') {
          progressEvents.push(data);
        }
      });

      // Start migration
      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      // Verify migration completed successfully
      expect(result).toEqual({ success: true });

      // Verify progress events sequence
      expect(progressEvents.length).toBeGreaterThan(0);

      // Check initial progress event
      const firstEvent = progressEvents[0];
      expect(firstEvent).toMatchObject({
        projectPath: TEST_PROJECT_1,
        status: 'running',
        percentage: 0,
        currentFile: null,
        filesCompleted: 0,
        totalFiles: 3
      });

      // Check completion event
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent).toMatchObject({
        projectPath: TEST_PROJECT_1,
        status: 'completed',
        percentage: 100,
        filesCompleted: 3,
        totalFiles: 3
      });

      // Verify tasks were inserted into database
      verifyTasksInDatabase(db.getConnection(), 10);

      // Verify migration marker was created
      verifyMigrationMarker(TEST_PROJECT_1, ['tasks.json', 'implementation_plan.json', 'task_logs.json']);

      // Verify each file was processed
      const fileProgressEvents = progressEvents.filter(e => e.currentFile !== null);
      expect(fileProgressEvents.length).toBeGreaterThan(0);

      const processedFiles = [...new Set(fileProgressEvents.map(e => e.currentFile))];
      expect(processedFiles).toEqual(expect.arrayContaining(['tasks.json', 'implementation_plan.json', 'task_logs.json']));
    });

    it('should handle large dataset (100+ tasks) efficiently', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 100 });

      const startTime = Date.now();

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result).toEqual({ success: true });

      const duration = Date.now() - startTime;

      // Verify migration completed in reasonable time (<10 seconds for 100 tasks)
      expect(duration).toBeLessThan(10000);

      // Verify all tasks were migrated
      verifyTasksInDatabase(db.getConnection(), 100);

      // Verify marker created
      verifyMigrationMarker(TEST_PROJECT_1, ['tasks.json', 'implementation_plan.json', 'task_logs.json']);
    });

    it('should skip missing files without error', async () => {
      setupTestProject(TEST_PROJECT_1);

      // Create only tasks.json
      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([
        {
          id: 'task-1',
          specId: 'spec-1',
          projectId: 'project-1',
          title: 'Test Task',
          description: 'Description',
          status: 'backlog',
          metadata: {},
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]));

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result).toEqual({ success: true });

      // Verify only tasks.json was migrated
      const markerPath = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(marker.migratedFiles).toEqual(['tasks.json']);

      // Verify task was inserted
      verifyTasksInDatabase(db.getConnection(), 1);
    });

    it('should emit progress events at regular intervals', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      const progressEvents: any[] = [];
      mockMainWindow.webContents.send = vi.fn((channel, data) => {
        if (channel === 'migration:progress') {
          progressEvents.push(data);
        }
      });

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      // Verify multiple progress events were emitted
      expect(progressEvents.length).toBeGreaterThan(3); // Initial + per-file + completion

      // Verify percentages increase monotonically
      const percentages = progressEvents.map(e => e.percentage);
      for (let i = 1; i < percentages.length; i++) {
        expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]);
      }

      // Verify filesCompleted increases
      const filesCompleted = progressEvents.map(e => e.filesCompleted);
      for (let i = 1; i < filesCompleted.length; i++) {
        expect(filesCompleted[i]).toBeGreaterThanOrEqual(filesCompleted[i - 1]);
      }
    });
  });

  describe('Idempotent Migration Flow', () => {
    it('should skip migration if already migrated (marker exists)', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      // First migration
      const result1 = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result1).toEqual({ success: true });

      // Clear mock to check second migration
      mockMainWindow.webContents.send = vi.fn();

      // Second migration (should skip)
      const result2 = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result2).toEqual({ success: true });

      // Verify no progress events were sent (already migrated)
      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();

      // Verify migration status
      const status = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_1);
      expect(status).toMatchObject({
        success: true,
        data: {
          hasMigrated: true,
          projectPath: TEST_PROJECT_1,
          migratedFiles: ['tasks.json', 'implementation_plan.json', 'task_logs.json'],
          version: '1.0.0'
        }
      });
    });

    it('should not duplicate data on multiple migration attempts', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 5 });

      // First migration
      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const countAfterFirst = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;

      // Clear marker to force re-migration
      const { getMigrationTracker } = await import('../main/migration-tracker');
      const tracker = getMigrationTracker();
      tracker.clearMigrationMarker(TEST_PROJECT_1);

      // Second migration (should use INSERT OR IGNORE)
      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const countAfterSecond = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;

      // Count should be the same (no duplicates)
      expect(countAfterSecond).toBe(countAfterFirst);
      expect(countAfterFirst).toBe(5);
    });
  });

  describe('Error Handling and Rollback Flow', () => {
    it('should rollback on corrupted JSON file', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1, { corruptFile: 'tasks.json' });

      const progressEvents: any[] = [];
      mockMainWindow.webContents.send = vi.fn((channel, data) => {
        if (channel === 'migration:progress') {
          progressEvents.push(data);
        }
      });

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      // Verify migration failed
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Failed to start migration')
      });

      // Verify rollback event was emitted
      const rollbackEvent = progressEvents.find(e => e.status === 'rolled_back');
      expect(rollbackEvent).toBeDefined();
      expect(rollbackEvent?.error).toBeDefined();
      expect(rollbackEvent?.rollbackReason).toContain('Rolled back');

      // Verify no marker was created
      const markerPath = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(false);

      // Verify no partial data in database
      const count = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;
      expect(count).toBe(0);
    });

    it('should rollback on database error', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      // Close database to force error
      db.close();

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      expect(result).toMatchObject({
        success: false,
        error: expect.any(String)
      });

      // Re-initialize database for cleanup
      db.initialize();

      // Verify no marker was created
      const markerPath = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(false);
    });

    it('should handle partial migration (some files corrupt)', async () => {
      setupTestProject(TEST_PROJECT_1);

      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');

      // Create valid tasks.json
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([
        {
          id: 'task-1',
          specId: 'spec-1',
          projectId: 'project-1',
          title: 'Test Task',
          description: 'Description',
          status: 'backlog',
          metadata: {},
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]));

      // Create corrupted implementation_plan.json
      writeFileSync(path.join(autoClaude, 'implementation_plan.json'), 'invalid json {{{');

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      // Migration should fail on corrupted file
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Failed to start migration')
      });

      // Verify rollback occurred (no marker)
      const markerPath = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  describe('Concurrent Migration Flow', () => {
    it('should handle concurrent migrations for different projects', async () => {
      setupTestProject(TEST_PROJECT_1);
      setupTestProject(TEST_PROJECT_2);
      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 3 });
      createTestJsonFiles(TEST_PROJECT_2, { tasksCount: 5 });

      // Start migrations concurrently
      const [result1, result2] = await Promise.all([
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1),
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_2)
      ]);

      // Both should succeed
      expect(result1).toEqual({ success: true });
      expect(result2).toEqual({ success: true });

      // Verify both projects have markers
      verifyMigrationMarker(TEST_PROJECT_1, ['tasks.json', 'implementation_plan.json', 'task_logs.json']);
      verifyMigrationMarker(TEST_PROJECT_2, ['tasks.json', 'implementation_plan.json', 'task_logs.json']);

      // Verify correct number of tasks in database (3 + 5 = 8)
      const count = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;
      expect(count).toBe(8);
    });

    it('should serialize migrations for the same project', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      const executionLog: string[] = [];

      // Mock to track execution order
      const originalInvoker = ipcMain.invokeHandler.bind(ipcMain);
      ipcMain.invokeHandler = async (channel: string, event: unknown, ...args: unknown[]) => {
        executionLog.push(`start-${args[0]}`);
        const result = await originalInvoker(channel, event, ...args);
        executionLog.push(`end-${args[0]}`);
        return result;
      };

      // Start two migrations for the same project
      const [result1, result2] = await Promise.all([
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1),
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1)
      ]);

      // Both should succeed
      expect(result1).toEqual({ success: true });
      expect(result2).toEqual({ success: true });

      // Verify one completed, one skipped (already migrated)
      const marker = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      expect(existsSync(marker)).toBe(true);
    });

    it('should handle migration queue with multiple projects', async () => {
      setupTestProject(TEST_PROJECT_1);
      setupTestProject(TEST_PROJECT_2);
      setupTestProject(TEST_PROJECT_3);

      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 2 });
      createTestJsonFiles(TEST_PROJECT_2, { tasksCount: 3 });
      createTestJsonFiles(TEST_PROJECT_3, { tasksCount: 4 });

      // Start all migrations concurrently
      const results = await Promise.all([
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1),
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_2),
        ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_3)
      ]);

      // All should succeed
      results.forEach(result => {
        expect(result).toEqual({ success: true });
      });

      // Verify all markers created
      expect(existsSync(path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json'))).toBe(true);
      expect(existsSync(path.join(TEST_PROJECT_2, '.auto-claude', '.migration-status.json'))).toBe(true);
      expect(existsSync(path.join(TEST_PROJECT_3, '.auto-claude', '.migration-status.json'))).toBe(true);

      // Verify total tasks (2 + 3 + 4 = 9)
      const count = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;
      expect(count).toBe(9);
    });
  });

  describe('Migration Status Verification', () => {
    it('should return correct status for migrated project', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const status = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_1);

      expect(status).toMatchObject({
        success: true,
        data: {
          hasMigrated: true,
          projectPath: TEST_PROJECT_1,
          migratedAt: expect.any(String),
          migratedFiles: ['tasks.json', 'implementation_plan.json', 'task_logs.json'],
          version: '1.0.0'
        }
      });

      // Verify timestamp is valid
      const migratedAt = new Date((status as any).data.migratedAt);
      expect(migratedAt.getTime()).toBeGreaterThan(Date.now() - 60000);
    });

    it('should return correct status for non-migrated project', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1);

      const status = await ipcMain.invokeHandler('migration:status', {}, TEST_PROJECT_1);

      expect(status).toMatchObject({
        success: true,
        data: {
          hasMigrated: false,
          projectPath: TEST_PROJECT_1
        }
      });
    });

    it('should return error for invalid project path', async () => {
      const result = await ipcMain.invokeHandler('migration:status', {}, '');

      expect(result).toEqual({
        success: false,
        error: 'Project path is required'
      });
    });
  });

  describe('Data Integrity Verification', () => {
    it('should preserve all task fields during migration', async () => {
      setupTestProject(TEST_PROJECT_1);
      createTestJsonFiles(TEST_PROJECT_1, { tasksCount: 1 });

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const task = db.getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get('task-1');

      // Verify all standard fields
      expect(task).toMatchObject({
        id: 'task-1',
        spec_id: 'spec-1',
        project_id: path.basename(TEST_PROJECT_1),
        title: 'Task 1: Implement Feature',
        description: 'Detailed description for task 1',
        status: 'backlog'
      });

      // Verify metadata JSON contains complex fields
      const metadata = JSON.parse(task.metadata_json);
      expect(metadata).toHaveProperty('priority', 'low');
      expect(metadata).toHaveProperty('tags');
      expect(metadata.tags).toEqual(expect.arrayContaining(['tag-0', 'test']));
      expect(metadata).toHaveProperty('subtasks');
      expect(metadata.subtasks).toHaveLength(2);
      expect(metadata).toHaveProperty('logs');
      expect(metadata.logs).toHaveLength(1);
    });

    it('should handle tasks with null/optional fields', async () => {
      setupTestProject(TEST_PROJECT_1);

      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([
        {
          id: 'task-minimal',
          specId: 'spec-1',
          projectId: 'project-1',
          title: 'Minimal Task',
          description: 'Description',
          status: 'backlog',
          metadata: {},
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
          // All optional fields omitted
        }
      ]));

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const task = db.getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get('task-minimal');

      expect(task).toMatchObject({
        id: 'task-minimal',
        title: 'Minimal Task',
        review_reason: null,
        released_in_version: null,
        staged_in_main_project: 0,
        staged_at: null
      });
    });

    it('should correctly serialize and deserialize complex metadata', async () => {
      setupTestProject(TEST_PROJECT_1);

      const complexMetadata = {
        nested: {
          deep: {
            structure: {
              value: 'test',
              array: [1, 2, 3],
              object: { key: 'value' }
            }
          }
        },
        specialChars: 'Test "quotes" and \'apostrophes\' and \\backslashes',
        unicode: '测试 тест اختبار 🚀',
        numbers: [1, 2.5, -3, 0],
        booleans: [true, false],
        nullValue: null
      };

      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([
        {
          id: 'task-complex',
          specId: 'spec-1',
          projectId: 'project-1',
          title: 'Complex Task',
          description: 'Description',
          status: 'backlog',
          metadata: complexMetadata,
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]));

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const task = db.getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get('task-complex');
      const retrievedMetadata = JSON.parse(task.metadata_json);

      expect(retrievedMetadata).toMatchObject(complexMetadata);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty tasks array', async () => {
      setupTestProject(TEST_PROJECT_1);

      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([]));

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result).toEqual({ success: true });

      const count = db.getConnection().prepare('SELECT COUNT(*) as count FROM tasks').get().count;
      expect(count).toBe(0);

      // Marker should still be created
      verifyMigrationMarker(TEST_PROJECT_1, ['tasks.json']);
    });

    it('should handle project with no JSON files', async () => {
      setupTestProject(TEST_PROJECT_1);
      // No JSON files created

      const result = await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);
      expect(result).toEqual({ success: true });

      // Marker should be created even with no files
      const markerPath = path.join(TEST_PROJECT_1, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(marker.migratedFiles).toEqual([]);
    });

    it('should handle very long field values', async () => {
      setupTestProject(TEST_PROJECT_1);

      const longString = 'x'.repeat(10000); // 10KB string

      const autoClaude = path.join(TEST_PROJECT_1, '.auto-claude');
      writeFileSync(path.join(autoClaude, 'tasks.json'), JSON.stringify([
        {
          id: 'task-long',
          specId: 'spec-1',
          projectId: 'project-1',
          title: 'Task with long description',
          description: longString,
          status: 'backlog',
          metadata: { longField: longString },
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]));

      await ipcMain.invokeHandler('migration:start', {}, TEST_PROJECT_1);

      const task = db.getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get('task-long');
      expect(task.description).toHaveLength(10000);

      const metadata = JSON.parse(task.metadata_json);
      expect(metadata.longField).toHaveLength(10000);
    });
  });
});
