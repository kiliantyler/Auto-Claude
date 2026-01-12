/**
 * Unit tests for UndoService
 * Tests undo/redo stack management and inverse operation generation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import type {
  UndoOperation,
  TaskCreateData,
  TaskUpdateData,
  TaskDeleteData,
  TaskStatusChangeData,
  TaskMoveData,
  BatchOperationData,
  Task,
  TaskSnapshot,
} from '../../shared/types';

// Test directories - will be initialized in beforeEach with mkdtempSync
let TEST_BASE_DIR: string;
let TEST_DB_PATH: string;

// Mock Electron before importing the service
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return TEST_BASE_DIR;
      return TEST_BASE_DIR;
    }),
  },
}));

// Setup and cleanup helpers
function setupTestEnvironment(): void {
  // Create secure temp directory with random suffix
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'undo-service-test-'));
  const autoClaudeDir = path.join(TEST_BASE_DIR, '.auto-claude');
  mkdirSync(autoClaudeDir, { recursive: true });
  TEST_DB_PATH = path.join(autoClaudeDir, 'tasks.db');
}

function cleanupTestDirs(): void {
  if (TEST_BASE_DIR && existsSync(TEST_BASE_DIR)) {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
}

/**
 * Creates the minimal schema needed for undo service tests
 */
function createTestSchema(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      review_reason TEXT,
      released_in_version TEXT,
      staged_in_main_project INTEGER DEFAULT 0,
      staged_at TEXT,
      location TEXT,
      specs_path TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS undo_stack (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      operation TEXT NOT NULL,
      inverse_operation TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_undo_stack_session ON undo_stack(session_id, sequence);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '003');
  `);
}

/**
 * Insert test task into the database
 */
function insertTestTask(
  db: import('better-sqlite3').Database,
  task: {
    id: string;
    spec_id: string;
    project_id: string;
    title: string;
    description?: string;
    status?: string;
    metadata_json?: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, spec_id, project_id, title, description, status, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id,
    task.spec_id,
    task.project_id,
    task.title,
    task.description ?? 'Test description',
    task.status ?? 'backlog',
    task.metadata_json ?? null
  );
}

/**
 * Create a mock Task object for testing
 */
function createMockTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-123',
    specId: '001-test',
    projectId: 'proj-1',
    title: 'Test Task',
    description: 'Test description',
    status: 'backlog',
    createdAt: new Date('2024-01-01T10:00:00Z'),
    updatedAt: new Date('2024-01-01T10:00:00Z'),
    subtasks: [],
    logs: [],
    ...overrides,
  };
}

describe('UndoService', () => {
  beforeEach(() => {
    setupTestEnvironment();
    vi.resetModules();
    // Clear ENABLE_UNDO env var
    delete process.env.ENABLE_UNDO;
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
    delete process.env.ENABLE_UNDO;
  });

  describe('createInverseOperation', () => {
    it('should create inverse for task_create (inverse is task_delete)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const taskSnapshot: TaskSnapshot = {
        id: 'task-123',
        specId: '001-test',
        projectId: 'proj-1',
        title: 'Test Task',
        description: 'Test description',
        status: 'backlog',
        createdAt: '2024-01-01T10:00:00Z',
        updatedAt: '2024-01-01T10:00:00Z',
      };

      const operation: UndoOperation = {
        type: 'task_create',
        taskId: 'task-123',
        data: {
          taskSnapshot,
        } as TaskCreateData,
      };

      const inverse = createInverseOperation(operation);

      expect(inverse.type).toBe('task_delete');
      expect(inverse.taskId).toBe('task-123');
      expect((inverse.data as TaskDeleteData).taskSnapshot).toEqual(taskSnapshot);
    });

    it('should create inverse for task_delete (inverse is task_create)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const taskSnapshot: TaskSnapshot = {
        id: 'task-123',
        specId: '001-test',
        projectId: 'proj-1',
        title: 'Test Task',
        description: 'Test description',
        status: 'backlog',
        createdAt: '2024-01-01T10:00:00Z',
        updatedAt: '2024-01-01T10:00:00Z',
      };

      const operation: UndoOperation = {
        type: 'task_delete',
        taskId: 'task-123',
        data: {
          taskSnapshot,
        } as TaskDeleteData,
      };

      const inverse = createInverseOperation(operation);

      expect(inverse.type).toBe('task_create');
      expect(inverse.taskId).toBe('task-123');
      expect((inverse.data as TaskCreateData).taskSnapshot).toEqual(taskSnapshot);
    });

    it('should create inverse for task_update (swaps old/new values)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old Title',
          newValue: 'New Title',
        } as TaskUpdateData,
      };

      const inverse = createInverseOperation(operation);

      expect(inverse.type).toBe('task_update');
      expect(inverse.taskId).toBe('task-123');
      expect((inverse.data as TaskUpdateData).fieldName).toBe('title');
      expect((inverse.data as TaskUpdateData).oldValue).toBe('New Title'); // Swapped
      expect((inverse.data as TaskUpdateData).newValue).toBe('Old Title'); // Swapped
    });

    it('should create inverse for task_status_change (swaps old/new status)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const operation: UndoOperation = {
        type: 'task_status_change',
        taskId: 'task-123',
        data: {
          oldStatus: 'backlog',
          newStatus: 'in_progress',
        } as TaskStatusChangeData,
      };

      const inverse = createInverseOperation(operation);

      expect(inverse.type).toBe('task_status_change');
      expect(inverse.taskId).toBe('task-123');
      expect((inverse.data as TaskStatusChangeData).oldStatus).toBe('in_progress'); // Swapped
      expect((inverse.data as TaskStatusChangeData).newStatus).toBe('backlog'); // Swapped
    });

    it('should create inverse for task_move (swaps old/new project IDs)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const operation: UndoOperation = {
        type: 'task_move',
        taskId: 'task-123',
        data: {
          oldProjectId: 'proj-1',
          newProjectId: 'proj-2',
          oldPosition: 0,
          newPosition: 5,
        } as TaskMoveData,
      };

      const inverse = createInverseOperation(operation);

      expect(inverse.type).toBe('task_move');
      expect(inverse.taskId).toBe('task-123');
      expect((inverse.data as TaskMoveData).oldProjectId).toBe('proj-2'); // Swapped
      expect((inverse.data as TaskMoveData).newProjectId).toBe('proj-1'); // Swapped
      expect((inverse.data as TaskMoveData).oldPosition).toBe(5); // Swapped
      expect((inverse.data as TaskMoveData).newPosition).toBe(0); // Swapped
    });

    it('should create inverse for batch (reversed and inverted operations)', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const operation1: UndoOperation = {
        type: 'task_update',
        taskId: 'task-1',
        data: {
          fieldName: 'title',
          oldValue: 'Old1',
          newValue: 'New1',
        } as TaskUpdateData,
      };

      const operation2: UndoOperation = {
        type: 'task_status_change',
        taskId: 'task-2',
        data: {
          oldStatus: 'backlog',
          newStatus: 'done',
        } as TaskStatusChangeData,
      };

      const batchOperation: UndoOperation = {
        type: 'batch',
        taskId: 'task-1',
        data: {
          operations: [operation1, operation2],
        } as BatchOperationData,
      };

      const inverse = createInverseOperation(batchOperation);

      expect(inverse.type).toBe('batch');
      expect(inverse.taskId).toBe('task-1');

      const inverseOps = (inverse.data as BatchOperationData).operations;
      expect(inverseOps).toHaveLength(2);

      // Operations should be reversed (task-2 first, then task-1)
      expect(inverseOps[0].taskId).toBe('task-2');
      expect(inverseOps[0].type).toBe('task_status_change');
      expect((inverseOps[0].data as TaskStatusChangeData).oldStatus).toBe('done');
      expect((inverseOps[0].data as TaskStatusChangeData).newStatus).toBe('backlog');

      expect(inverseOps[1].taskId).toBe('task-1');
      expect(inverseOps[1].type).toBe('task_update');
      expect((inverseOps[1].data as TaskUpdateData).oldValue).toBe('New1');
      expect((inverseOps[1].data as TaskUpdateData).newValue).toBe('Old1');
    });

    it('should throw error for unknown operation type', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const operation = {
        type: 'unknown_type' as any,
        taskId: 'task-123',
        data: {},
      };

      expect(() => createInverseOperation(operation)).toThrow('Cannot create inverse for unknown operation type');
    });
  });

  describe('createTaskSnapshot', () => {
    it('should create snapshot from task with all fields', async () => {
      const { createTaskSnapshot } = await import('../undo-service');

      const task = createMockTask({
        metadata: { priority: 'high', tags: ['test'] },
      });

      const snapshot = createTaskSnapshot(task);

      expect(snapshot.id).toBe(task.id);
      expect(snapshot.specId).toBe(task.specId);
      expect(snapshot.projectId).toBe(task.projectId);
      expect(snapshot.title).toBe(task.title);
      expect(snapshot.description).toBe(task.description);
      expect(snapshot.status).toBe(task.status);
      expect(snapshot.metadataJson).toBe(JSON.stringify(task.metadata));
      expect(snapshot.createdAt).toBe('2024-01-01T10:00:00.000Z');
      expect(snapshot.updatedAt).toBe('2024-01-01T10:00:00.000Z');
    });

    it('should handle task without metadata', async () => {
      const { createTaskSnapshot } = await import('../undo-service');

      const task = createMockTask({ metadata: undefined });

      const snapshot = createTaskSnapshot(task);

      expect(snapshot.metadataJson).toBeUndefined();
    });

    it('should handle string dates', async () => {
      const { createTaskSnapshot } = await import('../undo-service');

      const task = createMockTask({
        createdAt: '2024-06-15T12:00:00Z' as any,
        updatedAt: '2024-06-15T14:00:00Z' as any,
      });

      const snapshot = createTaskSnapshot(task);

      expect(snapshot.createdAt).toBe('2024-06-15T12:00:00Z');
      expect(snapshot.updatedAt).toBe('2024-06-15T14:00:00Z');
    });
  });

  describe('createTaskCreateOperationPair', () => {
    it('should create operation and inverse for task creation', async () => {
      const { createTaskCreateOperationPair } = await import('../undo-service');

      const task = createMockTask();

      const { operation, inverseOperation } = createTaskCreateOperationPair(task);

      expect(operation.type).toBe('task_create');
      expect(operation.taskId).toBe(task.id);
      expect((operation.data as TaskCreateData).taskSnapshot.title).toBe(task.title);

      expect(inverseOperation.type).toBe('task_delete');
      expect(inverseOperation.taskId).toBe(task.id);
    });
  });

  describe('createTaskDeleteOperationPair', () => {
    it('should create operation and inverse for task deletion', async () => {
      const { createTaskDeleteOperationPair } = await import('../undo-service');

      const task = createMockTask();

      const { operation, inverseOperation } = createTaskDeleteOperationPair(task);

      expect(operation.type).toBe('task_delete');
      expect(operation.taskId).toBe(task.id);
      expect((operation.data as TaskDeleteData).taskSnapshot.title).toBe(task.title);

      expect(inverseOperation.type).toBe('task_create');
      expect(inverseOperation.taskId).toBe(task.id);
    });
  });

  describe('createTaskUpdateOperationPair', () => {
    it('should create operation and inverse for task update', async () => {
      const { createTaskUpdateOperationPair } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskUpdateOperationPair(
        'task-123',
        'title',
        'Old Title',
        'New Title'
      );

      expect(operation.type).toBe('task_update');
      expect(operation.taskId).toBe('task-123');
      expect((operation.data as TaskUpdateData).fieldName).toBe('title');
      expect((operation.data as TaskUpdateData).oldValue).toBe('Old Title');
      expect((operation.data as TaskUpdateData).newValue).toBe('New Title');

      expect(inverseOperation.type).toBe('task_update');
      expect((inverseOperation.data as TaskUpdateData).oldValue).toBe('New Title');
      expect((inverseOperation.data as TaskUpdateData).newValue).toBe('Old Title');
    });
  });

  describe('createTaskStatusChangeOperationPair', () => {
    it('should create operation and inverse for status change', async () => {
      const { createTaskStatusChangeOperationPair } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskStatusChangeOperationPair(
        'task-123',
        'backlog',
        'in_progress'
      );

      expect(operation.type).toBe('task_status_change');
      expect(operation.taskId).toBe('task-123');
      expect((operation.data as TaskStatusChangeData).oldStatus).toBe('backlog');
      expect((operation.data as TaskStatusChangeData).newStatus).toBe('in_progress');

      expect(inverseOperation.type).toBe('task_status_change');
      expect((inverseOperation.data as TaskStatusChangeData).oldStatus).toBe('in_progress');
      expect((inverseOperation.data as TaskStatusChangeData).newStatus).toBe('backlog');
    });
  });

  describe('createTaskMoveOperationPair', () => {
    it('should create operation and inverse for task move', async () => {
      const { createTaskMoveOperationPair } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskMoveOperationPair(
        'task-123',
        'proj-1',
        'proj-2',
        0,
        5
      );

      expect(operation.type).toBe('task_move');
      expect(operation.taskId).toBe('task-123');
      expect((operation.data as TaskMoveData).oldProjectId).toBe('proj-1');
      expect((operation.data as TaskMoveData).newProjectId).toBe('proj-2');
      expect((operation.data as TaskMoveData).oldPosition).toBe(0);
      expect((operation.data as TaskMoveData).newPosition).toBe(5);

      expect(inverseOperation.type).toBe('task_move');
      expect((inverseOperation.data as TaskMoveData).oldProjectId).toBe('proj-2');
      expect((inverseOperation.data as TaskMoveData).newProjectId).toBe('proj-1');
    });

    it('should handle move without positions', async () => {
      const { createTaskMoveOperationPair } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskMoveOperationPair(
        'task-123',
        'proj-1',
        'proj-2'
      );

      expect((operation.data as TaskMoveData).oldPosition).toBeUndefined();
      expect((operation.data as TaskMoveData).newPosition).toBeUndefined();
      expect((inverseOperation.data as TaskMoveData).oldPosition).toBeUndefined();
      expect((inverseOperation.data as TaskMoveData).newPosition).toBeUndefined();
    });
  });

  describe('createBatchOperationPair', () => {
    it('should create batch operation and inverse', async () => {
      const { createBatchOperationPair, createTaskUpdateOperationPair } = await import('../undo-service');

      const op1 = createTaskUpdateOperationPair('task-1', 'title', 'Old1', 'New1').operation;
      const op2 = createTaskUpdateOperationPair('task-2', 'title', 'Old2', 'New2').operation;

      const { operation, inverseOperation } = createBatchOperationPair([op1, op2], 'task-1');

      expect(operation.type).toBe('batch');
      expect(operation.taskId).toBe('task-1');
      expect((operation.data as BatchOperationData).operations).toHaveLength(2);

      expect(inverseOperation.type).toBe('batch');
      const inverseOps = (inverseOperation.data as BatchOperationData).operations;
      expect(inverseOps).toHaveLength(2);
      // Reversed order
      expect(inverseOps[0].taskId).toBe('task-2');
      expect(inverseOps[1].taskId).toBe('task-1');
    });
  });

  describe('constructor and feature flag', () => {
    it('should enable undo by default', async () => {
      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      expect(service.isEnabled()).toBe(true);
    });

    it('should disable undo when ENABLE_UNDO is false', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      expect(service.isEnabled()).toBe(false);
    });

    it('should enable undo for any non-false value', async () => {
      process.env.ENABLE_UNDO = 'true';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      expect(service.isEnabled()).toBe(true);
    });

    it('should generate session ID on creation', async () => {
      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const sessionId = service.getSessionId();

      expect(sessionId).toBeDefined();
      expect(sessionId).toMatch(/^session-\d+-[a-z0-9]+$/);
    });
  });

  describe('startNewSession', () => {
    it('should generate a new session ID', async () => {
      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const oldSessionId = service.getSessionId();
      const newSessionId = service.startNewSession();

      expect(newSessionId).not.toBe(oldSessionId);
      expect(service.getSessionId()).toBe(newSessionId);
    });
  });

  describe('pushOperation', () => {
    it('should return null when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      const inverse: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'New',
          newValue: 'Old',
        } as TaskUpdateData,
      };

      const result = service.pushOperation(operation, inverse);

      expect(result).toBeNull();
    });

    it('should push operation to stack and return entry', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      const inverse: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'New',
          newValue: 'Old',
        } as TaskUpdateData,
      };

      const result = service.pushOperation(operation, inverse, {
        description: 'Update title',
      });

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_update');
      expect(result!.inverseOperation.type).toBe('task_update');
      expect(result!.description).toBe('Update title');
      expect(result!.sessionId).toBe(service.getSessionId());
    });

    it('should auto-generate description if not provided', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_status_change',
        taskId: 'task-123',
        data: {
          oldStatus: 'backlog',
          newStatus: 'done',
        } as TaskStatusChangeData,
      };

      const inverse: UndoOperation = {
        type: 'task_status_change',
        taskId: 'task-123',
        data: {
          oldStatus: 'done',
          newStatus: 'backlog',
        } as TaskStatusChangeData,
      };

      const result = service.pushOperation(operation, inverse);

      expect(result!.description).toBe('Change status from backlog to done');
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema - this will cause an error
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      const result = service.pushOperation(operation, operation);

      expect(result).toBeNull();
    });
  });

  describe('getStack', () => {
    it('should return empty stack when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const stack = service.getStack();

      expect(stack.undoStack).toEqual([]);
      expect(stack.redoStack).toEqual([]);
      expect(stack.canUndo).toBe(false);
      expect(stack.canRedo).toBe(false);
    });

    it('should return correct stack state after push', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      service.pushOperation(operation, operation);

      const stack = service.getStack();

      expect(stack.undoStack).toHaveLength(1);
      expect(stack.redoStack).toHaveLength(0);
      expect(stack.canUndo).toBe(true);
      expect(stack.canRedo).toBe(false);
    });
  });

  describe('undo', () => {
    it('should return error when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const result = service.undo();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Undo feature is disabled');
    });

    it('should return error when nothing to undo', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const result = service.undo();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Nothing to undo');
    });
  });

  describe('redo', () => {
    it('should return error when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const result = service.redo();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Undo feature is disabled');
    });

    it('should return error when nothing to redo', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const result = service.redo();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Nothing to redo');
    });
  });

  describe('clearStack', () => {
    it('should return 0 when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const result = service.clearStack();

      expect(result).toBe(0);
    });

    it('should clear current session entries by default', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      service.pushOperation(operation, operation);
      service.pushOperation(operation, operation);

      expect(service.getStack().undoStack).toHaveLength(2);

      const cleared = service.clearStack();

      expect(cleared).toBe(2);
      expect(service.getStack().undoStack).toHaveLength(0);
    });

    it('should clear all entries when all option is true', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      service.pushOperation(operation, operation);
      service.startNewSession();
      service.pushOperation(operation, operation);

      const cleared = service.clearStack({ all: true });

      expect(cleared).toBeGreaterThan(0);
    });

    it('should clear entries for specific session', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      const sessionId1 = service.getSessionId();
      service.pushOperation(operation, operation);

      service.startNewSession();
      const sessionId2 = service.getSessionId();
      service.pushOperation(operation, operation);

      const cleared = service.clearStack({ sessionId: sessionId1 });

      expect(cleared).toBe(1);
      // Session 2 should still have entries
      expect(service.getStack().undoStack).toHaveLength(1);
    });
  });

  describe('cleanupOldSessions', () => {
    it('should return 0 when undo is disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const result = service.cleanupOldSessions();

      expect(result).toBe(0);
    });

    it('should not throw on cleanup', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      expect(() => service.cleanupOldSessions()).not.toThrow();
    });
  });

  describe('convenience methods', () => {
    it('recordTaskCreate should push create operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const task = createMockTask();
      const result = service.recordTaskCreate(task);

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_create');
      expect(result!.description).toContain('Create task');
    });

    it('recordTaskDelete should push delete operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const task = createMockTask();
      const result = service.recordTaskDelete(task);

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_delete');
      expect(result!.description).toContain('Delete task');
    });

    it('recordTaskUpdate should push update operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const result = service.recordTaskUpdate('task-123', 'title', 'Old', 'New');

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_update');
      expect(result!.description).toBe('Update title');
    });

    it('recordStatusChange should push status change operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const result = service.recordStatusChange('task-123', 'backlog', 'done');

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_status_change');
      expect(result!.description).toContain('Change status');
    });

    it('recordTaskMove should push move operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const result = service.recordTaskMove('task-123', 'proj-1', 'proj-2');

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('task_move');
      expect(result!.description).toBe('Move task to different project');
    });

    it('recordBatchOperation should push batch operation', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService, createTaskUpdateOperationPair } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const op1 = createTaskUpdateOperationPair('task-1', 'title', 'Old1', 'New1').operation;
      const op2 = createTaskUpdateOperationPair('task-2', 'title', 'Old2', 'New2').operation;

      const result = service.recordBatchOperation([op1, op2], 'task-1', {
        description: 'Bulk update titles',
      });

      expect(result).not.toBeNull();
      expect(result!.operation.type).toBe('batch');
      expect(result!.description).toBe('Bulk update titles');
    });

    it('convenience methods should return null when disabled', async () => {
      process.env.ENABLE_UNDO = 'false';
      vi.resetModules();

      const { UndoService } = await import('../undo-service');
      const service = new UndoService();

      const task = createMockTask();

      expect(service.recordTaskCreate(task)).toBeNull();
      expect(service.recordTaskDelete(task)).toBeNull();
      expect(service.recordTaskUpdate('task-123', 'title', 'Old', 'New')).toBeNull();
      expect(service.recordStatusChange('task-123', 'backlog', 'done')).toBeNull();
      expect(service.recordTaskMove('task-123', 'proj-1', 'proj-2')).toBeNull();
      expect(service.recordBatchOperation([], 'task-123')).toBeNull();
    });
  });

  describe('singleton pattern', () => {
    it('should return the same instance from getUndoService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getUndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();

      const instance1 = getUndoService();
      const instance2 = getUndoService();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after resetUndoService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getUndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();

      const instance1 = getUndoService();
      resetUndoService();
      const instance2 = getUndoService();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('max stack size enforcement', () => {
    it('should remove oldest entries when stack exceeds max size', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { UndoService, resetUndoService } = await import('../undo-service');
      resetUndoService();
      const service = new UndoService();

      const operation: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Old',
          newValue: 'New',
        } as TaskUpdateData,
      };

      // Push more than default max stack size (50)
      for (let i = 0; i < 55; i++) {
        service.pushOperation(operation, operation, {
          description: `Operation ${i}`,
        });
      }

      const stack = service.getStack();

      // Should be capped at max stack size (50)
      expect(stack.undoStack.length).toBeLessThanOrEqual(50);
    });
  });

  describe('inverse operation roundtrip', () => {
    it('should produce original operation when inverse is applied twice', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const original: UndoOperation = {
        type: 'task_update',
        taskId: 'task-123',
        data: {
          fieldName: 'title',
          oldValue: 'Original',
          newValue: 'Updated',
        } as TaskUpdateData,
      };

      const inverse1 = createInverseOperation(original);
      const inverse2 = createInverseOperation(inverse1);

      // Double inverse should match original
      expect(inverse2.type).toBe(original.type);
      expect(inverse2.taskId).toBe(original.taskId);
      expect((inverse2.data as TaskUpdateData).oldValue).toBe('Original');
      expect((inverse2.data as TaskUpdateData).newValue).toBe('Updated');
    });

    it('should handle nested batch inverse roundtrip', async () => {
      const { createInverseOperation } = await import('../undo-service');

      const innerOp: UndoOperation = {
        type: 'task_status_change',
        taskId: 'task-1',
        data: {
          oldStatus: 'backlog',
          newStatus: 'done',
        } as TaskStatusChangeData,
      };

      const batchOp: UndoOperation = {
        type: 'batch',
        taskId: 'task-1',
        data: {
          operations: [innerOp],
        } as BatchOperationData,
      };

      const inverse1 = createInverseOperation(batchOp);
      const inverse2 = createInverseOperation(inverse1);

      const finalOps = (inverse2.data as BatchOperationData).operations;
      expect(finalOps).toHaveLength(1);
      expect(finalOps[0].type).toBe('task_status_change');
      expect((finalOps[0].data as TaskStatusChangeData).oldStatus).toBe('backlog');
      expect((finalOps[0].data as TaskStatusChangeData).newStatus).toBe('done');
    });
  });

  describe('edge cases', () => {
    it('should handle task with complex metadata in snapshot', async () => {
      const { createTaskSnapshot } = await import('../undo-service');

      const task = createMockTask({
        metadata: {
          priority: 'high',
          tags: ['urgent', 'bug'],
          nested: { deep: { value: 123 } },
        },
      });

      const snapshot = createTaskSnapshot(task);
      const parsedMetadata = JSON.parse(snapshot.metadataJson!);

      expect(parsedMetadata.priority).toBe('high');
      expect(parsedMetadata.tags).toEqual(['urgent', 'bug']);
      expect(parsedMetadata.nested.deep.value).toBe(123);
    });

    it('should handle empty batch operation', async () => {
      const { createBatchOperationPair } = await import('../undo-service');

      const { operation, inverseOperation } = createBatchOperationPair([], 'task-1');

      expect(operation.type).toBe('batch');
      expect((operation.data as BatchOperationData).operations).toHaveLength(0);
      expect((inverseOperation.data as BatchOperationData).operations).toHaveLength(0);
    });

    it('should handle update with null values', async () => {
      const { createTaskUpdateOperationPair, createInverseOperation } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskUpdateOperationPair(
        'task-123',
        'review_reason',
        null,
        'Needs review'
      );

      expect((operation.data as TaskUpdateData).oldValue).toBeNull();
      expect((operation.data as TaskUpdateData).newValue).toBe('Needs review');
      expect((inverseOperation.data as TaskUpdateData).oldValue).toBe('Needs review');
      expect((inverseOperation.data as TaskUpdateData).newValue).toBeNull();
    });

    it('should preserve task move positions correctly', async () => {
      const { createTaskMoveOperationPair, createInverseOperation } = await import('../undo-service');

      const { operation, inverseOperation } = createTaskMoveOperationPair(
        'task-123',
        'proj-1',
        'proj-2',
        3,
        7
      );

      // Verify inverse swaps positions correctly
      const moveData = operation.data as TaskMoveData;
      const inverseMoveData = inverseOperation.data as TaskMoveData;

      expect(moveData.oldPosition).toBe(3);
      expect(moveData.newPosition).toBe(7);
      expect(inverseMoveData.oldPosition).toBe(7);
      expect(inverseMoveData.newPosition).toBe(3);
    });
  });
});
