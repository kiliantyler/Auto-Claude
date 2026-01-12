/**
 * Unit tests for Task Storage
 * Tests CRUD operations and transaction support for task storage layer
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import type { Task, TaskStatus, ReviewReason, Subtask } from '../shared/types';
import { TaskStorage } from '../main/task-storage';
import { DatabaseConnection } from '../main/database';

// Helper to create test tasks
function createTestTask(overrides: Partial<Task> = {}): Task {
  const now = new Date();
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    specId: `spec-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    projectId: 'test-project-1',
    title: 'Test Task',
    description: 'Test task description',
    status: 'backlog' as TaskStatus,
    subtasks: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

// Helper to create test subtask
function createTestSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: `subtask-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    title: 'Test Subtask',
    description: 'Test subtask description',
    status: 'pending',
    files: [],
    ...overrides
  };
}

describe('TaskStorage', () => {
  let testDbPath: string;
  let dbConn: DatabaseConnection;
  let storage: TaskStorage;

  beforeEach(async () => {
    // Reset modules to clear singletons
    await vi.resetModules();

    // Create unique test database path
    testDbPath = path.join(
      '/tmp',
      `test-task-storage-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );

    // Initialize database connection
    dbConn = new DatabaseConnection(testDbPath);

    // Create tasks table schema
    const db = dbConn.getConnection();
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        review_reason TEXT,
        released_in_version TEXT,
        staged_in_main_project INTEGER DEFAULT 0,
        staged_at TEXT,
        location TEXT,
        specs_path TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    `);

    // Initialize storage (with dual-write disabled for tests)
    process.env.ENABLE_DUAL_WRITE = 'false';
    storage = new TaskStorage();
  });

  afterEach(() => {
    // Clean up
    dbConn.close();

    if (existsSync(testDbPath)) {
      try {
        rmSync(testDbPath, { force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Clean up WAL files
    [testDbPath + '-wal', testDbPath + '-shm'].forEach((file) => {
      if (existsSync(file)) {
        try {
          rmSync(file, { force: true });
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    });

    delete process.env.ENABLE_DUAL_WRITE;
  });

  describe('createTask', () => {
    it('should create a new task', () => {
      const task = createTestTask({ title: 'New Task', description: 'New task description' });

      const created = storage.createTask(task);

      expect(created).toBeDefined();
      expect(created.id).toBe(task.id);
      expect(created.title).toBe('New Task');
      expect(created.description).toBe('New task description');
    });

    it('should store task in database', () => {
      const task = createTestTask();
      storage.createTask(task);

      const retrieved = storage.getTask(task.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(task.id);
    });

    it('should handle tasks with subtasks', () => {
      const subtasks = [
        createTestSubtask({ title: 'Subtask 1' }),
        createTestSubtask({ title: 'Subtask 2' })
      ];
      const task = createTestTask({ subtasks });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.subtasks).toHaveLength(2);
      expect(retrieved?.subtasks[0].title).toBe('Subtask 1');
      expect(retrieved?.subtasks[1].title).toBe('Subtask 2');
    });

    it('should handle tasks with metadata', () => {
      const task = createTestTask({
        metadata: {
          category: 'feature',
          complexity: 'medium',
          priority: 'high',
          affectedFiles: ['file1.ts', 'file2.ts']
        }
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.metadata?.category).toBe('feature');
      expect(retrieved?.metadata?.complexity).toBe('medium');
      expect(retrieved?.metadata?.priority).toBe('high');
      expect(retrieved?.metadata?.affectedFiles).toEqual(['file1.ts', 'file2.ts']);
    });

    it('should handle tasks with QA report', () => {
      const task = createTestTask({
        qaReport: {
          status: 'passed',
          issues: [],
          timestamp: new Date()
        }
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.qaReport?.status).toBe('passed');
      expect(retrieved?.qaReport?.issues).toHaveLength(0);
    });

    it('should handle tasks with execution progress', () => {
      const task = createTestTask({
        executionProgress: {
          phase: 'planning',
          phaseProgress: 50,
          overallProgress: 25,
          currentSubtask: 'subtask-1',
          message: 'Creating plan'
        }
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.executionProgress?.phase).toBe('planning');
      expect(retrieved?.executionProgress?.phaseProgress).toBe(50);
      expect(retrieved?.executionProgress?.currentSubtask).toBe('subtask-1');
    });

    it('should preserve timestamps', () => {
      const createdAt = new Date('2024-01-01T00:00:00Z');
      const updatedAt = new Date('2024-01-02T00:00:00Z');
      const task = createTestTask({ createdAt, updatedAt });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.createdAt.toISOString()).toBe(createdAt.toISOString());
      expect(retrieved?.updatedAt.toISOString()).toBe(updatedAt.toISOString());
    });

    it('should handle optional fields correctly', () => {
      const task = createTestTask({
        reviewReason: 'qa_rejected' as ReviewReason,
        releasedInVersion: '1.0.0',
        stagedInMainProject: true,
        stagedAt: '2024-01-01T00:00:00Z',
        location: 'worktree' as const,
        specsPath: '/path/to/specs'
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.reviewReason).toBe('qa_rejected');
      expect(retrieved?.releasedInVersion).toBe('1.0.0');
      expect(retrieved?.stagedInMainProject).toBe(true);
      expect(retrieved?.stagedAt).toBe('2024-01-01T00:00:00Z');
      expect(retrieved?.location).toBe('worktree');
      expect(retrieved?.specsPath).toBe('/path/to/specs');
    });

    it('should throw error for duplicate task ID', () => {
      const task = createTestTask();
      storage.createTask(task);

      expect(() => {
        storage.createTask(task);
      }).toThrow();
    });

    it('should throw error for duplicate spec ID', () => {
      const task1 = createTestTask({ specId: 'same-spec-id' });
      const task2 = createTestTask({ id: 'different-id', specId: 'same-spec-id' });

      storage.createTask(task1);

      expect(() => {
        storage.createTask(task2);
      }).toThrow();
    });
  });

  describe('getTask', () => {
    it('should retrieve existing task by ID', () => {
      const task = createTestTask({ title: 'Retrieve Test' });
      storage.createTask(task);

      const retrieved = storage.getTask(task.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(task.id);
      expect(retrieved?.title).toBe('Retrieve Test');
    });

    it('should return null for non-existent task', () => {
      const retrieved = storage.getTask('non-existent-id');

      expect(retrieved).toBeNull();
    });

    it('should deserialize complex fields correctly', () => {
      const task = createTestTask({
        subtasks: [createTestSubtask()],
        logs: ['log1', 'log2'],
        metadata: { category: 'bug_fix' }
      });
      storage.createTask(task);

      const retrieved = storage.getTask(task.id);

      expect(retrieved?.subtasks).toHaveLength(1);
      expect(retrieved?.logs).toEqual(['log1', 'log2']);
      expect(retrieved?.metadata?.category).toBe('bug_fix');
    });
  });

  describe('getTaskBySpecId', () => {
    it('should retrieve task by spec ID', () => {
      const task = createTestTask({ specId: 'unique-spec-id' });
      storage.createTask(task);

      const retrieved = storage.getTaskBySpecId('unique-spec-id');

      expect(retrieved).toBeDefined();
      expect(retrieved?.specId).toBe('unique-spec-id');
    });

    it('should return null for non-existent spec ID', () => {
      const retrieved = storage.getTaskBySpecId('non-existent-spec-id');

      expect(retrieved).toBeNull();
    });
  });

  describe('updateTask', () => {
    it('should update task by ID', () => {
      const task = createTestTask({ title: 'Original Title', description: 'Original' });
      storage.createTask(task);

      const updated = storage.updateTask(task.id, {
        title: 'Updated Title',
        description: 'Updated'
      });

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated Title');
      expect(updated?.description).toBe('Updated');
    });

    it('should merge updates with existing task', () => {
      const task = createTestTask({ title: 'Original', status: 'backlog' });
      storage.createTask(task);

      const updated = storage.updateTask(task.id, { status: 'in_progress' });

      expect(updated?.title).toBe('Original');
      expect(updated?.status).toBe('in_progress');
    });

    it('should update timestamp', () => {
      const task = createTestTask({ updatedAt: new Date('2024-01-01') });
      storage.createTask(task);

      // Wait a bit to ensure different timestamp
      const updated = storage.updateTask(task.id, { status: 'in_progress' });

      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        new Date('2024-01-01').getTime()
      );
    });

    it('should return null for non-existent task', () => {
      const updated = storage.updateTask('non-existent-id', { status: 'in_progress' });

      expect(updated).toBeNull();
    });

    it('should handle status updates', () => {
      const task = createTestTask({ status: 'backlog' });
      storage.createTask(task);

      const updated = storage.updateTask(task.id, { status: 'in_progress' });

      expect(updated?.status).toBe('in_progress');
    });

    it('should handle subtask updates', () => {
      const task = createTestTask({ subtasks: [] });
      storage.createTask(task);

      const newSubtasks = [createTestSubtask({ title: 'New Subtask' })];
      const updated = storage.updateTask(task.id, { subtasks: newSubtasks });

      expect(updated?.subtasks).toHaveLength(1);
      expect(updated?.subtasks[0].title).toBe('New Subtask');
    });

    it('should handle metadata updates', () => {
      const task = createTestTask({ metadata: { category: 'feature' } });
      storage.createTask(task);

      const updated = storage.updateTask(task.id, {
        metadata: { category: 'bug_fix', priority: 'high' }
      });

      expect(updated?.metadata?.category).toBe('bug_fix');
      expect(updated?.metadata?.priority).toBe('high');
    });

    it('should handle clearing optional fields', () => {
      const task = createTestTask({ reviewReason: 'qa_rejected' as ReviewReason });
      storage.createTask(task);

      const updated = storage.updateTask(task.id, { reviewReason: undefined });

      expect(updated?.reviewReason).toBeUndefined();
    });
  });

  describe('deleteTask', () => {
    it('should delete existing task', () => {
      const task = createTestTask();
      storage.createTask(task);

      const deleted = storage.deleteTask(task.id);

      expect(deleted).toBe(true);
      expect(storage.getTask(task.id)).toBeNull();
    });

    it('should return false for non-existent task', () => {
      const deleted = storage.deleteTask('non-existent-id');

      expect(deleted).toBe(false);
    });

    it('should remove task from list queries', () => {
      const task = createTestTask({ projectId: 'project-1' });
      storage.createTask(task);

      storage.deleteTask(task.id);

      const tasks = storage.listTasks('project-1');
      expect(tasks).toHaveLength(0);
    });
  });

  describe('listTasks', () => {
    it('should list all tasks when no filters provided', () => {
      const task1 = createTestTask({ projectId: 'project-1' });
      const task2 = createTestTask({ projectId: 'project-2' });
      storage.createTask(task1);
      storage.createTask(task2);

      const tasks = storage.listTasks();

      expect(tasks).toHaveLength(2);
    });

    it('should filter by project ID', () => {
      const task1 = createTestTask({ projectId: 'project-1' });
      const task2 = createTestTask({ projectId: 'project-2' });
      const task3 = createTestTask({ projectId: 'project-1' });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks('project-1');

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.projectId === 'project-1')).toBe(true);
    });

    it('should filter by status', () => {
      const task1 = createTestTask({ status: 'backlog' });
      const task2 = createTestTask({ status: 'in_progress' });
      const task3 = createTestTask({ status: 'backlog' });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks(undefined, { status: 'backlog' });

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status === 'backlog')).toBe(true);
    });

    it('should filter by location', () => {
      const task1 = createTestTask({ location: 'main' as const });
      const task2 = createTestTask({ location: 'worktree' as const });
      const task3 = createTestTask({ location: 'main' as const });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks(undefined, { location: 'main' });

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.location === 'main')).toBe(true);
    });

    it('should exclude archived tasks when filter enabled', () => {
      const task1 = createTestTask({ metadata: {} });
      const task2 = createTestTask({
        metadata: { archivedAt: '2024-01-01T00:00:00Z' }
      });
      const task3 = createTestTask({ metadata: {} });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks(undefined, { excludeArchived: true });

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => !t.metadata?.archivedAt)).toBe(true);
    });

    it('should combine multiple filters', () => {
      const task1 = createTestTask({ projectId: 'project-1', status: 'backlog' });
      const task2 = createTestTask({ projectId: 'project-1', status: 'in_progress' });
      const task3 = createTestTask({ projectId: 'project-2', status: 'backlog' });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks('project-1', { status: 'backlog' });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task1.id);
    });

    it('should order by updated_at DESC', () => {
      const task1 = createTestTask({ updatedAt: new Date('2024-01-01') });
      const task2 = createTestTask({ updatedAt: new Date('2024-01-03') });
      const task3 = createTestTask({ updatedAt: new Date('2024-01-02') });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.listTasks();

      expect(tasks[0].id).toBe(task2.id); // Most recent
      expect(tasks[1].id).toBe(task3.id);
      expect(tasks[2].id).toBe(task1.id); // Oldest
    });

    it('should return empty array when no matches', () => {
      const tasks = storage.listTasks('non-existent-project');

      expect(tasks).toHaveLength(0);
    });
  });

  describe('getTasksByStatus', () => {
    it('should get tasks by status', () => {
      const task1 = createTestTask({ status: 'backlog' });
      const task2 = createTestTask({ status: 'in_progress' });
      const task3 = createTestTask({ status: 'backlog' });
      storage.createTask(task1);
      storage.createTask(task2);
      storage.createTask(task3);

      const tasks = storage.getTasksByStatus('backlog');

      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.status === 'backlog')).toBe(true);
    });

    it('should filter by project ID when provided', () => {
      const task1 = createTestTask({ projectId: 'project-1', status: 'backlog' });
      const task2 = createTestTask({ projectId: 'project-2', status: 'backlog' });
      storage.createTask(task1);
      storage.createTask(task2);

      const tasks = storage.getTasksByStatus('backlog', 'project-1');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task1.id);
    });
  });

  describe('withTransaction', () => {
    it('should execute multiple operations atomically', () => {
      const task1 = createTestTask({ title: 'Task 1' });
      const task2 = createTestTask({ title: 'Task 2' });

      storage.withTransaction(() => {
        storage.createTask(task1);
        storage.createTask(task2);
      });

      const tasks = storage.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('should rollback on error', () => {
      const task1 = createTestTask({ title: 'Task 1' });
      const task2 = createTestTask({ id: 'duplicate-id', title: 'Task 2' });

      try {
        storage.withTransaction(() => {
          storage.createTask(task1);
          storage.createTask(task2);
          // Create duplicate - should cause error
          storage.createTask(task2);
        });
      } catch (error) {
        // Expected error
      }

      // Transaction should rollback, so no tasks created
      const tasks = storage.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('should support nested CRUD operations', () => {
      const task1 = createTestTask({ title: 'Task 1', status: 'backlog' });
      const task2 = createTestTask({ title: 'Task 2', status: 'backlog' });

      storage.withTransaction(() => {
        storage.createTask(task1);
        storage.createTask(task2);
        storage.updateTask(task1.id, { status: 'in_progress' });
        storage.deleteTask(task2.id);
      });

      const tasks = storage.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task1.id);
      expect(tasks[0].status).toBe('in_progress');
    });

    it('should return result from transaction function', () => {
      const task = createTestTask();

      const result = storage.withTransaction(() => {
        storage.createTask(task);
        return { success: true, taskId: task.id };
      });

      expect(result).toEqual({ success: true, taskId: task.id });
    });

    it('should prevent race conditions in concurrent updates', () => {
      const task = createTestTask({ title: 'Original', description: 'Original' });
      storage.createTask(task);

      // Simulate concurrent updates in transaction
      storage.withTransaction(() => {
        const current = storage.getTask(task.id);
        if (current) {
          storage.updateTask(task.id, { title: 'Updated 1' });
          storage.updateTask(task.id, { description: 'Updated 2' });
        }
      });

      const final = storage.getTask(task.id);
      expect(final?.title).toBe('Updated 1');
      expect(final?.description).toBe('Updated 2');
    });
  });

  describe('data integrity', () => {
    it('should maintain referential integrity', () => {
      const task = createTestTask({
        subtasks: [
          createTestSubtask({ title: 'Subtask 1' }),
          createTestSubtask({ title: 'Subtask 2' })
        ]
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.subtasks).toHaveLength(2);
      expect(retrieved?.subtasks).toEqual(task.subtasks);
    });

    it('should handle special characters in fields', () => {
      const task = createTestTask({
        title: "Task with \"quotes\" and 'apostrophes'",
        description: 'Description with\nnewlines\nand\ttabs'
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.title).toBe(task.title);
      expect(retrieved?.description).toBe(task.description);
    });

    it('should handle large JSON metadata', () => {
      const largeMetadata = {
        category: 'feature' as const,
        affectedFiles: Array.from({ length: 100 }, (_, i) => `file${i}.ts`),
        acceptanceCriteria: Array.from({ length: 50 }, (_, i) => `Criterion ${i}`)
      };

      const task = createTestTask({ metadata: largeMetadata });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.metadata?.affectedFiles).toHaveLength(100);
      expect(retrieved?.metadata?.acceptanceCriteria).toHaveLength(50);
    });

    it('should handle tasks with no metadata', () => {
      const task = createTestTask({ metadata: undefined });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.metadata).toBeUndefined();
    });

    it('should preserve boolean values correctly', () => {
      const task = createTestTask({
        stagedInMainProject: true,
        metadata: { requireReviewBeforeCoding: false }
      });

      storage.createTask(task);
      const retrieved = storage.getTask(task.id);

      expect(retrieved?.stagedInMainProject).toBe(true);
      expect(retrieved?.metadata?.requireReviewBeforeCoding).toBe(false);
    });
  });
});
