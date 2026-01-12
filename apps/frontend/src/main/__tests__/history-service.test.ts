/**
 * Unit tests for HistoryService
 * Tests task history query operations from SQLite database
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'history-service-test-'));
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
 * Creates the minimal schema needed for history service tests
 */
function createTestSchema(db: import('better-sqlite3').Database): void {
  // Create tasks table
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

    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '003');
  `);
}

/**
 * Insert test history entries into the database
 */
function insertTestHistory(
  db: import('better-sqlite3').Database,
  entries: {
    task_id: string;
    action: string;
    field_name?: string;
    old_value?: string;
    new_value?: string;
    changed_by?: string;
    timestamp?: string;
    session_id?: string;
  }[]
): void {
  const stmt = db.prepare(`
    INSERT INTO task_history (task_id, action, field_name, old_value, new_value, changed_by, timestamp, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of entries) {
    stmt.run(
      entry.task_id,
      entry.action,
      entry.field_name ?? null,
      entry.old_value ?? null,
      entry.new_value ?? null,
      entry.changed_by ?? 'user',
      entry.timestamp ?? new Date().toISOString(),
      entry.session_id ?? null
    );
  }
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
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, spec_id, project_id, title, description, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id,
    task.spec_id,
    task.project_id,
    task.title,
    task.description ?? 'Test description',
    task.status ?? 'backlog'
  );
}

describe('HistoryService', () => {
  beforeEach(() => {
    setupTestEnvironment();
    vi.resetModules();
    // Clear ENABLE_TASK_HISTORY env var
    delete process.env.ENABLE_TASK_HISTORY;
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
    delete process.env.ENABLE_TASK_HISTORY;
  });

  describe('constructor and feature flag', () => {
    it('should enable task history by default', async () => {
      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      expect(service.isEnabled()).toBe(true);
    });

    it('should disable task history when ENABLE_TASK_HISTORY is false', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      expect(service.isEnabled()).toBe(false);
    });

    it('should enable task history for any non-false value', async () => {
      process.env.ENABLE_TASK_HISTORY = 'true';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('getTaskHistory', () => {
    it('should return empty result when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123');

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should return empty result for non-existent task', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('nonexistent-task');

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return history entries for a task', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-123',
        spec_id: '001-test',
        project_id: 'proj-1',
        title: 'Test Task',
      });

      insertTestHistory(db, [
        { task_id: 'task-123', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-123', action: 'updated', field_name: 'title', old_value: 'Old', new_value: 'New', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-123', action: 'status_changed', field_name: 'status', old_value: 'backlog', new_value: 'in_progress', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123');

      expect(result.entries).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
      // Entries should be sorted by timestamp DESC (newest first)
      expect(result.entries[0].action).toBe('status_changed');
      expect(result.entries[2].action).toBe('created');
    });

    it('should convert database row to TaskHistoryEntry correctly', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        {
          task_id: 'task-123',
          action: 'updated',
          field_name: 'title',
          old_value: 'Old Title',
          new_value: 'New Title',
          changed_by: 'agent',
          timestamp: '2024-01-01T10:00:00Z',
          session_id: 'session-abc',
        },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123');
      const entry = result.entries[0];

      expect(entry.id).toBe(1);
      expect(entry.taskId).toBe('task-123');
      expect(entry.action).toBe('updated');
      expect(entry.fieldName).toBe('title');
      expect(entry.oldValue).toBe('Old Title');
      expect(entry.newValue).toBe('New Title');
      expect(entry.changedBy).toBe('agent');
      expect(entry.timestamp).toBe('2024-01-01T10:00:00Z');
      expect(entry.sessionId).toBe('session-abc');
    });

    it('should respect limit option', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert 10 entries
      const entries = Array.from({ length: 10 }, (_, i) => ({
        task_id: 'task-123',
        action: 'updated',
        timestamp: `2024-01-01T${String(i).padStart(2, '0')}:00:00Z`,
      }));
      insertTestHistory(db, entries);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123', { limit: 5 });

      expect(result.entries).toHaveLength(5);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it('should respect offset option for pagination', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      const entries = Array.from({ length: 10 }, (_, i) => ({
        task_id: 'task-123',
        action: 'updated',
        field_name: `field-${i}`,
        timestamp: `2024-01-01T${String(i).padStart(2, '0')}:00:00Z`,
      }));
      insertTestHistory(db, entries);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123', { limit: 3, offset: 3 });

      expect(result.entries).toHaveLength(3);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema - this will cause an error
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-123');

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('getRecentChanges', () => {
    it('should return empty array when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.getRecentChanges();

      expect(result).toEqual([]);
    });

    it('should return recent changes across all tasks', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task One', status: 'backlog' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task Two', status: 'in_progress' });

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-2', action: 'created', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentChanges();

      expect(result).toHaveLength(3);
      expect(result[0].entry.timestamp).toBe('2024-01-01T12:00:00Z');
      expect(result[0].taskTitle).toBe('Task One');
      expect(result[0].taskStatus).toBe('backlog');
    });

    it('should respect limit parameter', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      const entries = Array.from({ length: 100 }, (_, i) => ({
        task_id: 'task-1',
        action: 'updated',
        timestamp: new Date(2024, 0, 1, i % 24, i % 60).toISOString(),
      }));
      insertTestHistory(db, entries);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentChanges(10);

      expect(result).toHaveLength(10);
    });

    it('should filter by action type', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-1', action: 'status_changed', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentChanges(50, { action: 'updated' });

      expect(result).toHaveLength(1);
      expect(result[0].entry.action).toBe('updated');
    });

    it('should filter by date range', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-02T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-03T10:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentChanges(50, {
        startDate: '2024-01-02T00:00:00Z',
        endDate: '2024-01-02T23:59:59Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].entry.timestamp).toBe('2024-01-02T10:00:00Z');
    });

    it('should handle unknown task gracefully', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert history without corresponding task
      insertTestHistory(db, [
        { task_id: 'deleted-task', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentChanges();

      expect(result).toHaveLength(1);
      expect(result[0].taskTitle).toBe('Unknown Task');
      expect(result[0].taskStatus).toBe('unknown');
    });
  });

  describe('getSessionChanges', () => {
    it('should return null when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.getSessionChanges('session-123');

      expect(result).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getSessionChanges('nonexistent-session');

      expect(result).toBeNull();
    });

    it('should return grouped session changes', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', session_id: 'session-abc', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-abc', timestamp: '2024-01-01T10:05:00Z' },
        { task_id: 'task-2', action: 'created', session_id: 'session-abc', timestamp: '2024-01-01T10:10:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-xyz', timestamp: '2024-01-01T11:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getSessionChanges('session-abc');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('session-abc');
      expect(result!.entries).toHaveLength(3);
      expect(result!.startTime).toBe('2024-01-01T10:00:00Z');
      expect(result!.endTime).toBe('2024-01-01T10:10:00Z');
    });

    it('should order entries by timestamp ASC', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'updated', session_id: 'session-abc', timestamp: '2024-01-01T10:30:00Z' },
        { task_id: 'task-1', action: 'created', session_id: 'session-abc', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'status_changed', session_id: 'session-abc', timestamp: '2024-01-01T10:15:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getSessionChanges('session-abc');

      expect(result!.entries[0].action).toBe('created');
      expect(result!.entries[1].action).toBe('status_changed');
      expect(result!.entries[2].action).toBe('updated');
    });
  });

  describe('getRecentSessions', () => {
    it('should return empty array when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.getRecentSessions();

      expect(result).toEqual([]);
    });

    it('should return recent sessions with entry counts', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', session_id: 'session-1', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-1', timestamp: '2024-01-01T10:05:00Z' },
        { task_id: 'task-2', action: 'created', session_id: 'session-2', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-2', action: 'updated', session_id: 'session-2', timestamp: '2024-01-01T11:30:00Z' },
        { task_id: 'task-2', action: 'status_changed', session_id: 'session-2', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentSessions();

      expect(result).toHaveLength(2);
      // Should be sorted by last activity DESC
      expect(result[0].sessionId).toBe('session-2');
      expect(result[0].entryCount).toBe(3);
      expect(result[1].sessionId).toBe('session-1');
      expect(result[1].entryCount).toBe(2);
    });

    it('should respect limit parameter', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      const entries = Array.from({ length: 30 }, (_, i) => ({
        task_id: 'task-1',
        action: 'updated',
        session_id: `session-${i}`,
        timestamp: new Date(2024, 0, 1, i % 24, i % 60).toISOString(),
      }));
      insertTestHistory(db, entries);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentSessions(5);

      expect(result).toHaveLength(5);
    });

    it('should exclude entries without session_id', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', session_id: 'session-1', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-2', action: 'created', timestamp: '2024-01-01T11:00:00Z' }, // No session_id
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getRecentSessions();

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('session-1');
    });
  });

  describe('queryHistory', () => {
    it('should return empty result when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.queryHistory({});

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should filter by taskId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-2', action: 'created', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.queryHistory({ taskId: 'task-1' });

      expect(result.entries).toHaveLength(2);
      expect(result.total).toBe(2);
      result.entries.forEach((entry) => {
        expect(entry.taskId).toBe('task-1');
      });
    });

    it('should filter by action', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-1', action: 'deleted', timestamp: '2024-01-01T12:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.queryHistory({ action: 'created' });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe('created');
    });

    it('should filter by sessionId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', session_id: 'session-1', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-2', timestamp: '2024-01-01T11:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.queryHistory({ sessionId: 'session-1' });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].sessionId).toBe('session-1');
    });

    it('should combine multiple filters', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created', session_id: 'session-1', timestamp: '2024-01-01T10:00:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-1', timestamp: '2024-01-01T11:00:00Z' },
        { task_id: 'task-2', action: 'updated', session_id: 'session-1', timestamp: '2024-01-01T12:00:00Z' },
        { task_id: 'task-1', action: 'updated', session_id: 'session-2', timestamp: '2024-01-01T13:00:00Z' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.queryHistory({
        taskId: 'task-1',
        action: 'updated',
        sessionId: 'session-1',
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].taskId).toBe('task-1');
      expect(result.entries[0].action).toBe('updated');
      expect(result.entries[0].sessionId).toBe('session-1');
    });

    it('should support pagination with limit and offset', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      const entries = Array.from({ length: 25 }, (_, i) => ({
        task_id: 'task-1',
        action: 'updated',
        timestamp: `2024-01-01T${String(i).padStart(2, '0')}:00:00Z`,
      }));
      insertTestHistory(db, entries);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const page1 = service.queryHistory({ limit: 10, offset: 0 });
      const page2 = service.queryHistory({ limit: 10, offset: 10 });
      const page3 = service.queryHistory({ limit: 10, offset: 20 });

      expect(page1.entries).toHaveLength(10);
      expect(page1.total).toBe(25);
      expect(page1.hasMore).toBe(true);

      expect(page2.entries).toHaveLength(10);
      expect(page2.hasMore).toBe(true);

      expect(page3.entries).toHaveLength(5);
      expect(page3.hasMore).toBe(false);
    });
  });

  describe('getTaskHistoryCount', () => {
    it('should return 0 when history is disabled', async () => {
      process.env.ENABLE_TASK_HISTORY = 'false';
      vi.resetModules();

      const { HistoryService } = await import('../history-service');
      const service = new HistoryService();

      const result = service.getTaskHistoryCount('task-123');

      expect(result).toBe(0);
    });

    it('should return 0 for non-existent task', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistoryCount('nonexistent');

      expect(result).toBe(0);
    });

    it('should return correct count for task', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created' },
        { task_id: 'task-1', action: 'updated' },
        { task_id: 'task-1', action: 'status_changed' },
        { task_id: 'task-2', action: 'created' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistoryCount('task-1');

      expect(result).toBe(3);
    });
  });

  describe('singleton pattern', () => {
    it('should return the same instance from getHistoryService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getHistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();

      const instance1 = getHistoryService();
      const instance2 = getHistoryService();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after resetHistoryService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getHistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();

      const instance1 = getHistoryService();
      resetHistoryService();
      const instance2 = getHistoryService();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('rowToEntry conversion', () => {
    it('should handle null field_name', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-1');

      expect(result.entries[0].fieldName).toBeUndefined();
    });

    it('should handle null values', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'updated', field_name: 'title' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-1');

      expect(result.entries[0].oldValue).toBeUndefined();
      expect(result.entries[0].newValue).toBeUndefined();
    });

    it('should default changedBy to user when null', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert directly without changed_by
      db.prepare(`
        INSERT INTO task_history (task_id, action, timestamp)
        VALUES (?, ?, ?)
      `).run('task-1', 'created', '2024-01-01T10:00:00Z');
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-1');

      expect(result.entries[0].changedBy).toBe('user');
    });

    it('should handle null session_id', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestHistory(db, [
        { task_id: 'task-1', action: 'created' },
      ]);
      db.close();

      const { HistoryService, resetHistoryService } = await import('../history-service');
      resetHistoryService();
      const service = new HistoryService();

      const result = service.getTaskHistory('task-1');

      expect(result.entries[0].sessionId).toBeUndefined();
    });
  });
});
