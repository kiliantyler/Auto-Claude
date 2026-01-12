/**
 * Unit tests for Migration Worker
 * Tests JSON to SQLite migration with transaction safety, retries, and progress tracking
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import type { MigrationProgress } from '../migration-worker';

// Test directories
const TEST_DIR = '/tmp/migration-worker-test';
const TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');

// Mock database connection
const mockRun = vi.fn();
const mockPrepare = vi.fn(() => ({ run: mockRun }));
const mockGetConnection = vi.fn(() => ({ prepare: mockPrepare }));
const mockWithTransaction = vi.fn((callback: () => void) => {
  callback();
});

// Mock database module
vi.mock('../database', () => ({
  getDatabaseConnection: vi.fn(() => ({
    getConnection: mockGetConnection,
    withTransaction: mockWithTransaction
  }))
}));

// Mock migration tracker
const mockHasMigrated = vi.fn(() => false);
const mockMarkMigrationComplete = vi.fn();
const mockClearMigrationMarker = vi.fn();

vi.mock('../migration-tracker', () => ({
  getMigrationTracker: vi.fn(() => ({
    hasMigrated: mockHasMigrated,
    markMigrationComplete: mockMarkMigrationComplete,
    clearMigrationMarker: mockClearMigrationMarker
  }))
}));

// Setup test directories
function setupTestDirs(): void {
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
  mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });
}

// Cleanup test directories
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Create sample JSON files
function createSampleJsonFiles(): void {
  const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');

  // tasks.json
  const tasks = [
    {
      id: 'task-1',
      specId: '001-feature',
      projectId: 'project-1',
      title: 'Test Task',
      description: 'Test description',
      status: 'backlog',
      metadata: {},
      subtasks: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    }
  ];
  writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify(tasks));

  // implementation_plan.json
  const plan = { feature: 'Test Feature', phases: [] };
  writeFileSync(path.join(autoBuildDir, 'implementation_plan.json'), JSON.stringify(plan));

  // task_logs.json
  const logs = { taskId: 'task-1', logs: [] };
  writeFileSync(path.join(autoBuildDir, 'task_logs.json'), JSON.stringify(logs));
}

describe('MigrationWorker', () => {
  beforeEach(async () => {
    cleanupTestDirs();
    setupTestDirs();
    vi.resetModules();
    vi.clearAllMocks();

    // Reset mock implementations
    mockHasMigrated.mockReturnValue(false);
    mockRun.mockReturnValue(undefined);
    mockWithTransaction.mockImplementation((callback: () => void) => {
      callback();
    });
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('migrate', () => {
    it('should skip migration if already migrated', async () => {
      mockHasMigrated.mockReturnValue(true);

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockHasMigrated).toHaveBeenCalledWith(TEST_PROJECT_PATH);
      expect(mockMarkMigrationComplete).not.toHaveBeenCalled();
    });

    it('should migrate all JSON files when present', async () => {
      createSampleJsonFiles();

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockMarkMigrationComplete).toHaveBeenCalledWith(
        TEST_PROJECT_PATH,
        ['tasks.json', 'implementation_plan.json', 'task_logs.json']
      );
    });

    it('should skip missing files without error', async () => {
      // Create only tasks.json
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify([]));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockMarkMigrationComplete).toHaveBeenCalledWith(
        TEST_PROJECT_PATH,
        ['tasks.json']
      );
    });

    it('should call progress callback with correct events', async () => {
      createSampleJsonFiles();

      const progressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        progressEvents.push(progress);
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, onProgress);

      expect(onProgress).toHaveBeenCalled();
      expect(progressEvents.length).toBeGreaterThan(0);

      // Check initial progress
      const firstEvent = progressEvents[0];
      expect(firstEvent.status).toBe('running');
      expect(firstEvent.percentage).toBe(0);
      expect(firstEvent.totalFiles).toBe(3);

      // Check completion event
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent.status).toBe('completed');
      expect(lastEvent.percentage).toBe(100);
      expect(lastEvent.filesCompleted).toBe(3);
    });

    it('should rollback on migration failure', async () => {
      createSampleJsonFiles();

      // Make transaction throw error
      mockWithTransaction.mockImplementation(() => {
        throw new Error('Database error');
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(worker.migrate(TEST_PROJECT_PATH)).rejects.toThrow('Database error');

      expect(mockClearMigrationMarker).toHaveBeenCalledWith(TEST_PROJECT_PATH);
      expect(mockMarkMigrationComplete).not.toHaveBeenCalled();
    });

    it('should emit rollback progress on failure', async () => {
      createSampleJsonFiles();

      mockWithTransaction.mockImplementation(() => {
        throw new Error('Database error');
      });

      const progressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        progressEvents.push(progress);
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(worker.migrate(TEST_PROJECT_PATH, onProgress)).rejects.toThrow();

      const rollbackEvent = progressEvents.find(e => e.status === 'rolled_back');
      expect(rollbackEvent).toBeDefined();
      expect(rollbackEvent?.error).toBeDefined();
      expect(rollbackEvent?.rollbackReason).toContain('Rolled back');
    });

    it('should retry on transient errors', async () => {
      createSampleJsonFiles();

      let attemptCount = 0;
      mockWithTransaction.mockImplementation((callback: () => void) => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error('Transient error');
        }
        callback();
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, undefined, {
        maxRetries: 3,
        retryDelayMs: 10
      });

      expect(attemptCount).toBeGreaterThan(1);
      expect(mockMarkMigrationComplete).toHaveBeenCalled();
    });

    it('should fail after max retries exceeded', async () => {
      createSampleJsonFiles();

      mockWithTransaction.mockImplementation(() => {
        throw new Error('Persistent error');
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(
        worker.migrate(TEST_PROJECT_PATH, undefined, {
          maxRetries: 2,
          retryDelayMs: 10
        })
      ).rejects.toThrow();

      expect(mockClearMigrationMarker).toHaveBeenCalled();
    });

    it('should include retry count in progress events', async () => {
      createSampleJsonFiles();

      let attemptCount = 0;
      mockWithTransaction.mockImplementation((callback: () => void) => {
        attemptCount++;
        if (attemptCount === 1) {
          throw new Error('Transient error');
        }
        callback();
      });

      const progressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        progressEvents.push(progress);
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, onProgress, {
        maxRetries: 3,
        retryDelayMs: 10
      });

      const eventsWithRetry = progressEvents.filter(e => e.retryCount && e.retryCount > 0);
      expect(eventsWithRetry.length).toBeGreaterThan(0);
    });
  });

  describe('concurrency control', () => {
    it('should serialize migrations for the same project', async () => {
      createSampleJsonFiles();

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      const executionOrder: number[] = [];

      // First migration
      const promise1 = worker.migrate(TEST_PROJECT_PATH).then(() => {
        executionOrder.push(1);
      });

      // Second migration (should wait for first)
      const promise2 = worker.migrate(TEST_PROJECT_PATH).then(() => {
        executionOrder.push(2);
      });

      await Promise.all([promise1, promise2]);

      // Second migration should be skipped (already migrated marker set by first)
      expect(executionOrder).toEqual([1, 2]);
    });

    it('should allow parallel migrations for different projects', async () => {
      createSampleJsonFiles();

      const project2Path = path.join(TEST_DIR, 'test-project-2');
      mkdirSync(project2Path, { recursive: true });
      mkdirSync(path.join(project2Path, '.auto-claude'), { recursive: true });

      // Create JSON files for second project
      const autoBuildDir2 = path.join(project2Path, '.auto-claude');
      writeFileSync(path.join(autoBuildDir2, 'tasks.json'), JSON.stringify([]));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      const startTimes: number[] = [];

      const promise1 = worker.migrate(TEST_PROJECT_PATH).then(() => {
        startTimes.push(Date.now());
      });

      const promise2 = worker.migrate(project2Path).then(() => {
        startTimes.push(Date.now());
      });

      await Promise.all([promise1, promise2]);

      // Both should complete successfully
      expect(startTimes).toHaveLength(2);
      expect(mockMarkMigrationComplete).toHaveBeenCalledTimes(2);
    });
  });

  describe('tasks migration', () => {
    it('should insert tasks into database with correct fields', async () => {
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      const tasks = [
        {
          id: 'task-1',
          specId: '001-feature',
          projectId: 'project-1',
          title: 'Test Task',
          description: 'Test description',
          status: 'backlog',
          reviewReason: 'needs review',
          releasedInVersion: '1.0.0',
          stagedInMainProject: true,
          stagedAt: '2024-01-02T00:00:00Z',
          location: '/test/path',
          specsPath: '/specs/001',
          metadata: { key: 'value' },
          subtasks: [],
          qaReport: null,
          logs: [],
          executionProgress: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify(tasks));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO tasks')
      );

      expect(mockRun).toHaveBeenCalledWith(
        'task-1',
        '001-feature',
        'project-1',
        'Test Task',
        'Test description',
        'backlog',
        'needs review',
        '1.0.0',
        1,
        '2024-01-02T00:00:00.000Z',
        '/test/path',
        '/specs/001',
        expect.stringContaining('"key":"value"'),
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z'
      );
    });

    it('should handle single task object', async () => {
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      const task = {
        id: 'task-1',
        specId: '001-feature',
        projectId: 'project-1',
        title: 'Test Task',
        description: 'Test description',
        status: 'backlog',
        metadata: {},
        subtasks: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z'
      };
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify(task));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('should handle empty task array', async () => {
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify([]));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should serialize complex metadata to JSON', async () => {
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      const tasks = [
        {
          id: 'task-1',
          specId: '001-feature',
          projectId: 'project-1',
          title: 'Test Task',
          description: 'Test description',
          status: 'backlog',
          metadata: { custom: 'data' },
          subtasks: [{ id: 'sub-1', name: 'Subtask 1' }],
          qaReport: { status: 'approved' },
          logs: [{ timestamp: '2024-01-01', message: 'Log entry' }],
          executionProgress: { current: 1, total: 5 },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), JSON.stringify(tasks));

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      const metadataArg = mockRun.mock.calls[0][12];
      const parsedMetadata = JSON.parse(metadataArg);

      expect(parsedMetadata.custom).toBe('data');
      expect(parsedMetadata.subtasks).toHaveLength(1);
      expect(parsedMetadata.qaReport.status).toBe('approved');
      expect(parsedMetadata.logs).toHaveLength(1);
      expect(parsedMetadata.executionProgress.current).toBe(1);
    });
  });

  describe('transaction handling', () => {
    it('should wrap file migration in transaction', async () => {
      createSampleJsonFiles();

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH);

      expect(mockWithTransaction).toHaveBeenCalled();
    });

    it('should rollback transaction on error', async () => {
      createSampleJsonFiles();

      let transactionCallback: (() => void) | null = null;
      mockWithTransaction.mockImplementation((callback: () => void) => {
        transactionCallback = callback;
        throw new Error('Transaction rolled back');
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(worker.migrate(TEST_PROJECT_PATH)).rejects.toThrow();

      // Transaction should have been attempted
      expect(mockWithTransaction).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle JSON parse errors', async () => {
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      writeFileSync(path.join(autoBuildDir, 'tasks.json'), 'invalid json {{{');

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(worker.migrate(TEST_PROJECT_PATH)).rejects.toThrow();
      expect(mockClearMigrationMarker).toHaveBeenCalled();
    });

    it('should handle database insert errors', async () => {
      createSampleJsonFiles();

      mockRun.mockImplementation(() => {
        throw new Error('Database constraint violation');
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await expect(worker.migrate(TEST_PROJECT_PATH)).rejects.toThrow();
      expect(mockClearMigrationMarker).toHaveBeenCalled();
    });

    it('should continue rollback even if marker clear fails', async () => {
      createSampleJsonFiles();

      mockWithTransaction.mockImplementation(() => {
        throw new Error('Migration failed');
      });

      mockClearMigrationMarker.mockImplementation(() => {
        throw new Error('Failed to clear marker');
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      // Should throw original error, not rollback error
      await expect(worker.migrate(TEST_PROJECT_PATH)).rejects.toThrow('Migration failed');
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance on multiple calls', async () => {
      const { getMigrationWorker } = await import('../migration-worker');

      const instance1 = getMigrationWorker();
      const instance2 = getMigrationWorker();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after module reset', async () => {
      const { getMigrationWorker } = await import('../migration-worker');
      const instance1 = getMigrationWorker();

      vi.resetModules();

      const { getMigrationWorker: getWorkerAfterReset } = await import('../migration-worker');
      const instance2 = getWorkerAfterReset();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('progress tracking', () => {
    it('should emit progress for each file', async () => {
      createSampleJsonFiles();

      const fileProgressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        if (progress.currentFile) {
          fileProgressEvents.push(progress);
        }
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, onProgress);

      expect(fileProgressEvents.length).toBeGreaterThan(0);
      expect(fileProgressEvents.some(e => e.currentFile === 'tasks.json')).toBe(true);
      expect(fileProgressEvents.some(e => e.currentFile === 'implementation_plan.json')).toBe(true);
      expect(fileProgressEvents.some(e => e.currentFile === 'task_logs.json')).toBe(true);
    });

    it('should update percentage correctly', async () => {
      createSampleJsonFiles();

      const progressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        progressEvents.push(progress);
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, onProgress);

      // Check percentages increase
      const percentages = progressEvents.map(e => e.percentage);
      expect(percentages[0]).toBe(0);
      expect(percentages[percentages.length - 1]).toBe(100);

      // Check percentage is always between 0-100
      percentages.forEach(p => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      });
    });

    it('should update filesCompleted counter', async () => {
      createSampleJsonFiles();

      const progressEvents: MigrationProgress[] = [];
      const onProgress = vi.fn((progress: MigrationProgress) => {
        progressEvents.push(progress);
      });

      const { MigrationWorker } = await import('../migration-worker');
      const worker = new MigrationWorker();

      await worker.migrate(TEST_PROJECT_PATH, onProgress);

      const completedCounts = progressEvents.map(e => e.filesCompleted);
      expect(completedCounts[0]).toBe(0);
      expect(completedCounts[completedCounts.length - 1]).toBe(3);
    });
  });
});
