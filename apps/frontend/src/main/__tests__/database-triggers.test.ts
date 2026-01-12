/**
 * Integration tests for database triggers
 * Tests task history triggers and FTS5 sync triggers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Test directories - will be initialized in beforeEach with mkdtempSync
let TEST_BASE_DIR: string;
let TEST_DB_PATH: string;

// Mock Electron before importing any modules
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
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'database-triggers-test-'));
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
 * Creates the full schema with all triggers for integration testing
 */
function createFullSchema(db: import('better-sqlite3').Database): void {
  db.exec(`
    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      auto_build_path TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Tasks table
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Task History Table
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

    -- Event queue table
    CREATE TABLE IF NOT EXISTS event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Metadata table
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- FTS5 virtual table for task search
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title,
      description,
      tags,
      content='tasks',
      content_rowid='rowid'
    );

    INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '003');

    -- ============================================
    -- Triggers for Task History
    -- ============================================

    -- Task History INSERT trigger
    CREATE TRIGGER IF NOT EXISTS task_history_on_insert
    AFTER INSERT ON tasks
    BEGIN
      INSERT INTO task_history (task_id, action, new_value, changed_by, session_id)
      VALUES (
        NEW.id,
        'created',
        json_object('title', NEW.title, 'status', NEW.status, 'description', NEW.description),
        'user',
        NULL
      );
    END;

    -- Task History UPDATE trigger
    CREATE TRIGGER IF NOT EXISTS task_history_on_update
    AFTER UPDATE ON tasks
    BEGIN
      INSERT INTO task_history (task_id, action, field_name, old_value, new_value, changed_by, session_id)
      VALUES (
        NEW.id,
        CASE WHEN OLD.status != NEW.status THEN 'status_changed' ELSE 'updated' END,
        CASE
          WHEN OLD.status != NEW.status THEN 'status'
          WHEN OLD.title != NEW.title THEN 'title'
          ELSE NULL
        END,
        json_object('title', OLD.title, 'status', OLD.status, 'description', OLD.description),
        json_object('title', NEW.title, 'status', NEW.status, 'description', NEW.description),
        'user',
        NULL
      );
    END;

    -- Task History DELETE trigger
    CREATE TRIGGER IF NOT EXISTS task_history_on_delete
    AFTER DELETE ON tasks
    BEGIN
      INSERT INTO task_history (task_id, action, old_value, changed_by, session_id)
      VALUES (
        OLD.id,
        'deleted',
        json_object('title', OLD.title, 'status', OLD.status, 'description', OLD.description),
        'user',
        NULL
      );
    END;

    -- ============================================
    -- Triggers for FTS5 Sync
    -- ============================================

    -- FTS5 INSERT trigger
    CREATE TRIGGER IF NOT EXISTS tasks_fts_insert
    AFTER INSERT ON tasks
    BEGIN
      INSERT INTO tasks_fts(rowid, title, description, tags)
      VALUES (
        NEW.rowid,
        NEW.title,
        NEW.description,
        json_extract(NEW.metadata_json, '$.tags')
      );
    END;

    -- FTS5 UPDATE trigger
    CREATE TRIGGER IF NOT EXISTS tasks_fts_update
    AFTER UPDATE ON tasks
    BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
      VALUES (
        'delete',
        OLD.rowid,
        OLD.title,
        OLD.description,
        json_extract(OLD.metadata_json, '$.tags')
      );
      INSERT INTO tasks_fts(rowid, title, description, tags)
      VALUES (
        NEW.rowid,
        NEW.title,
        NEW.description,
        json_extract(NEW.metadata_json, '$.tags')
      );
    END;

    -- FTS5 DELETE trigger
    CREATE TRIGGER IF NOT EXISTS tasks_fts_delete
    AFTER DELETE ON tasks
    BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
      VALUES (
        'delete',
        OLD.rowid,
        OLD.title,
        OLD.description,
        json_extract(OLD.metadata_json, '$.tags')
      );
    END;

    -- ============================================
    -- Triggers for Event System
    -- ============================================

    -- Task INSERT trigger for events
    CREATE TRIGGER IF NOT EXISTS task_inserted
    AFTER INSERT ON tasks
    BEGIN
      INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
      VALUES ('insert', NEW.id, 'task', datetime('now'));
    END;

    -- Task UPDATE trigger for events
    CREATE TRIGGER IF NOT EXISTS task_updated
    AFTER UPDATE ON tasks
    BEGIN
      INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
      VALUES ('update', NEW.id, 'task', datetime('now'));
    END;

    -- Task DELETE trigger for events
    CREATE TRIGGER IF NOT EXISTS task_deleted
    AFTER DELETE ON tasks
    BEGIN
      INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
      VALUES ('delete', OLD.id, 'task', datetime('now'));
    END;
  `);
}

/**
 * Insert a project for foreign key constraint
 */
function insertTestProject(
  db: import('better-sqlite3').Database,
  project: {
    id: string;
    name: string;
    path: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, path, auto_build_path, settings_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(project.id, project.name, project.path, `${project.path}/.auto-claude`, '{}');
}

/**
 * Insert a test task
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

describe('Database Triggers Integration Tests', () => {
  beforeEach(() => {
    setupTestEnvironment();
    vi.resetModules();
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('Task History Triggers', () => {
    describe('task_history_on_insert trigger', () => {
      it('should create history entry when task is inserted', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, {
          id: 'proj-1',
          name: 'Test Project',
          path: '/test/project',
        });

        insertTestTask(db, {
          id: 'task-123',
          spec_id: '001-test',
          project_id: 'proj-1',
          title: 'New Task',
          description: 'Task description',
          status: 'backlog',
        });

        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').all('task-123');
        db.close();

        expect(history).toHaveLength(1);
        const entry = history[0] as {
          task_id: string;
          action: string;
          new_value: string;
          changed_by: string;
        };
        expect(entry.task_id).toBe('task-123');
        expect(entry.action).toBe('created');
        expect(entry.changed_by).toBe('user');

        const newValue = JSON.parse(entry.new_value);
        expect(newValue.title).toBe('New Task');
        expect(newValue.status).toBe('backlog');
        expect(newValue.description).toBe('Task description');
      });

      it('should capture complete task data in JSON format', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-456',
          spec_id: '002-feature',
          project_id: 'proj-1',
          title: 'Feature Implementation',
          description: 'Implement the new feature with tests',
          status: 'in_progress',
        });

        const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-456') as {
          new_value: string;
          old_value: string | null;
        };
        db.close();

        const newValue = JSON.parse(entry.new_value);
        expect(newValue.title).toBe('Feature Implementation');
        expect(newValue.description).toBe('Implement the new feature with tests');
        expect(newValue.status).toBe('in_progress');
        expect(entry.old_value).toBeNull();
      });
    });

    describe('task_history_on_update trigger', () => {
      it('should create history entry with status_changed action when status changes', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-789',
          spec_id: '003-update',
          project_id: 'proj-1',
          title: 'Update Test',
          status: 'backlog',
        });

        // Clear the insert history entry
        db.prepare('DELETE FROM task_history').run();

        // Update the status
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', 'task-789');

        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').all('task-789');
        db.close();

        expect(history).toHaveLength(1);
        const entry = history[0] as {
          action: string;
          field_name: string;
          old_value: string;
          new_value: string;
        };
        expect(entry.action).toBe('status_changed');
        expect(entry.field_name).toBe('status');

        const oldValue = JSON.parse(entry.old_value);
        const newValue = JSON.parse(entry.new_value);
        expect(oldValue.status).toBe('backlog');
        expect(newValue.status).toBe('in_progress');
      });

      it('should create history entry with updated action when title changes', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-title',
          spec_id: '004-title',
          project_id: 'proj-1',
          title: 'Original Title',
        });

        db.prepare('DELETE FROM task_history').run();

        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Updated Title', 'task-title');

        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').all('task-title');
        db.close();

        expect(history).toHaveLength(1);
        const entry = history[0] as {
          action: string;
          field_name: string;
          old_value: string;
          new_value: string;
        };
        expect(entry.action).toBe('updated');
        expect(entry.field_name).toBe('title');

        const oldValue = JSON.parse(entry.old_value);
        const newValue = JSON.parse(entry.new_value);
        expect(oldValue.title).toBe('Original Title');
        expect(newValue.title).toBe('Updated Title');
      });

      it('should track multiple consecutive updates', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-multi',
          spec_id: '005-multi',
          project_id: 'proj-1',
          title: 'Multi Update',
          status: 'backlog',
        });

        db.prepare('DELETE FROM task_history').run();

        // Multiple updates
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('in_progress', 'task-multi');
        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('New Title', 'task-multi');
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', 'task-multi');

        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY id').all('task-multi');
        db.close();

        expect(history).toHaveLength(3);
        const actions = (history as { action: string }[]).map((h) => h.action);
        expect(actions).toContain('status_changed');
        expect(actions).toContain('updated');
      });

      it('should preserve both old and new values in JSON format', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-preserve',
          spec_id: '006-preserve',
          project_id: 'proj-1',
          title: 'Old Title',
          description: 'Old Description',
          status: 'backlog',
        });

        db.prepare('DELETE FROM task_history').run();

        db.prepare('UPDATE tasks SET title = ?, description = ?, status = ? WHERE id = ?').run(
          'New Title',
          'New Description',
          'in_progress',
          'task-preserve'
        );

        const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-preserve') as {
          old_value: string;
          new_value: string;
        };
        db.close();

        const oldValue = JSON.parse(entry.old_value);
        const newValue = JSON.parse(entry.new_value);

        expect(oldValue.title).toBe('Old Title');
        expect(oldValue.description).toBe('Old Description');
        expect(oldValue.status).toBe('backlog');

        expect(newValue.title).toBe('New Title');
        expect(newValue.description).toBe('New Description');
        expect(newValue.status).toBe('in_progress');
      });
    });

    describe('task_history_on_delete trigger', () => {
      it('should create history entry when task is deleted', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-delete',
          spec_id: '007-delete',
          project_id: 'proj-1',
          title: 'Task To Delete',
          description: 'This will be deleted',
          status: 'done',
        });

        db.prepare('DELETE FROM task_history').run();

        // Delete the task
        db.prepare('DELETE FROM tasks WHERE id = ?').run('task-delete');

        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').all('task-delete');
        db.close();

        expect(history).toHaveLength(1);
        const entry = history[0] as {
          action: string;
          old_value: string;
          new_value: string | null;
        };
        expect(entry.action).toBe('deleted');
        expect(entry.new_value).toBeNull();

        const oldValue = JSON.parse(entry.old_value);
        expect(oldValue.title).toBe('Task To Delete');
        expect(oldValue.description).toBe('This will be deleted');
        expect(oldValue.status).toBe('done');
      });

      it('should preserve deleted task data for audit trail', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-audit',
          spec_id: '008-audit',
          project_id: 'proj-1',
          title: 'Audit Trail Task',
          description: 'Important task for audit',
          status: 'in_progress',
        });

        db.prepare('DELETE FROM task_history').run();
        db.prepare('DELETE FROM tasks WHERE id = ?').run('task-audit');

        // Task should be gone
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-audit');
        expect(task).toBeUndefined();

        // But history should remain
        const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-audit') as {
          old_value: string;
        };
        db.close();

        expect(history).toBeDefined();
        const oldValue = JSON.parse(history.old_value);
        expect(oldValue.title).toBe('Audit Trail Task');
      });
    });

    describe('History trigger edge cases', () => {
      it('should handle tasks with null description', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        // Insert task directly with null description (workaround for NOT NULL constraint)
        db.prepare(
          `INSERT INTO tasks (id, spec_id, project_id, title, description, status) VALUES (?, ?, ?, ?, '', ?)`
        ).run('task-null', '009-null', 'proj-1', 'Null Desc Task', 'backlog');

        const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-null') as {
          new_value: string;
        };
        db.close();

        const newValue = JSON.parse(entry.new_value);
        expect(newValue.description).toBe('');
      });

      it('should handle special characters in task data', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-special',
          spec_id: '010-special',
          project_id: 'proj-1',
          title: 'Task with "quotes" and \'apostrophes\'',
          description: 'Description with\nnewlines\tand\ttabs',
        });

        const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-special') as {
          new_value: string;
        };
        db.close();

        const newValue = JSON.parse(entry.new_value);
        expect(newValue.title).toBe('Task with "quotes" and \'apostrophes\'');
        expect(newValue.description).toContain('\n');
        expect(newValue.description).toContain('\t');
      });

      it('should handle unicode characters in task data', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-unicode',
          spec_id: '011-unicode',
          project_id: 'proj-1',
          title: 'Task with emojis 🚀 and accents é à ü',
          description: '日本語テスト Chinese: 中文 Korean: 한국어',
        });

        const entry = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-unicode') as {
          new_value: string;
        };
        db.close();

        const newValue = JSON.parse(entry.new_value);
        expect(newValue.title).toContain('🚀');
        expect(newValue.description).toContain('日本語');
        expect(newValue.description).toContain('中文');
        expect(newValue.description).toContain('한국어');
      });
    });
  });

  describe('FTS5 Sync Triggers', () => {
    describe('tasks_fts_insert trigger', () => {
      it('should sync task to FTS index on insert', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-fts-1',
          spec_id: '020-fts',
          project_id: 'proj-1',
          title: 'Authentication Feature',
          description: 'Implement user login and registration',
        });

        // Search for the task using FTS
        const results = db
          .prepare(
            `
          SELECT t.* FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH ?
        `
          )
          .all('authentication');
        db.close();

        expect(results).toHaveLength(1);
        const task = results[0] as { id: string; title: string };
        expect(task.id).toBe('task-fts-1');
        expect(task.title).toBe('Authentication Feature');
      });

      it('should index task title for FTS search', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-title-search',
          spec_id: '021-title',
          project_id: 'proj-1',
          title: 'UniqueSearchableTitle',
          description: 'Regular description',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'UniqueSearchableTitle'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-title-search');
      });

      it('should index task description for FTS search', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-desc-search',
          spec_id: '022-desc',
          project_id: 'proj-1',
          title: 'Simple Title',
          description: 'This has UniqueDescriptionKeyword in it',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'UniqueDescriptionKeyword'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-desc-search');
      });

      it('should index task tags from metadata_json for FTS search', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-tags-search',
          spec_id: '023-tags',
          project_id: 'proj-1',
          title: 'Task with tags',
          description: 'Regular description',
          metadata_json: JSON.stringify({ tags: ['uniquetagforsearch', 'security'] }),
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'uniquetagforsearch'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-tags-search');
      });

      it('should handle null metadata_json gracefully', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-no-meta',
          spec_id: '024-nometa',
          project_id: 'proj-1',
          title: 'Task without metadata',
          description: 'No metadata json',
        });

        // Should not throw and task should be searchable
        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'metadata'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
      });
    });

    describe('tasks_fts_update trigger', () => {
      it('should update FTS index when task title changes', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-update-fts',
          spec_id: '025-update',
          project_id: 'proj-1',
          title: 'OriginalTitleKeyword',
          description: 'Description',
        });

        // Update the title
        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('UpdatedTitleKeyword', 'task-update-fts');

        // Old title should not be found
        const oldResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'OriginalTitleKeyword'
        `
          )
          .all();

        // New title should be found
        const newResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'UpdatedTitleKeyword'
        `
          )
          .all();
        db.close();

        expect(oldResults).toHaveLength(0);
        expect(newResults).toHaveLength(1);
        expect((newResults[0] as { id: string }).id).toBe('task-update-fts');
      });

      it('should update FTS index when task description changes', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-desc-update',
          spec_id: '026-desc-update',
          project_id: 'proj-1',
          title: 'Title',
          description: 'OldDescKeyword',
        });

        db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run('NewDescKeyword', 'task-desc-update');

        const oldResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'OldDescKeyword'
        `
          )
          .all();

        const newResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'NewDescKeyword'
        `
          )
          .all();
        db.close();

        expect(oldResults).toHaveLength(0);
        expect(newResults).toHaveLength(1);
      });

      it('should update FTS index when task tags change', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-tags-update',
          spec_id: '027-tags-update',
          project_id: 'proj-1',
          title: 'Title',
          description: 'Description',
          metadata_json: JSON.stringify({ tags: ['oldtagkeyword'] }),
        });

        db.prepare('UPDATE tasks SET metadata_json = ? WHERE id = ?').run(
          JSON.stringify({ tags: ['newtagkeyword'] }),
          'task-tags-update'
        );

        const oldResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'oldtagkeyword'
        `
          )
          .all();

        const newResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'newtagkeyword'
        `
          )
          .all();
        db.close();

        expect(oldResults).toHaveLength(0);
        expect(newResults).toHaveLength(1);
      });

      it('should handle multiple consecutive updates correctly', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-multi-update',
          spec_id: '028-multi',
          project_id: 'proj-1',
          title: 'FirstTitle',
          description: 'FirstDescription',
        });

        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('SecondTitle', 'task-multi-update');
        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('ThirdTitle', 'task-multi-update');
        db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('FinalTitle', 'task-multi-update');

        // Only final title should be searchable
        const firstResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'FirstTitle'
        `
          )
          .all();

        const finalResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'FinalTitle'
        `
          )
          .all();
        db.close();

        expect(firstResults).toHaveLength(0);
        expect(finalResults).toHaveLength(1);
      });
    });

    describe('tasks_fts_delete trigger', () => {
      it('should remove task from FTS index when deleted', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-delete-fts',
          spec_id: '029-delete',
          project_id: 'proj-1',
          title: 'DeleteMeKeyword',
          description: 'This task will be deleted',
        });

        // Verify task is searchable before delete
        const beforeResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'DeleteMeKeyword'
        `
          )
          .all();
        expect(beforeResults).toHaveLength(1);

        // Delete the task
        db.prepare('DELETE FROM tasks WHERE id = ?').run('task-delete-fts');

        // Verify task is no longer searchable
        const afterResults = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'DeleteMeKeyword'
        `
          )
          .all();
        db.close();

        expect(afterResults).toHaveLength(0);
      });

      it('should not affect other tasks in FTS index when one is deleted', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        insertTestTask(db, {
          id: 'task-keep-1',
          spec_id: '030-keep1',
          project_id: 'proj-1',
          title: 'SearchableTask One',
          description: 'First searchable task',
        });

        insertTestTask(db, {
          id: 'task-delete-mid',
          spec_id: '031-delete',
          project_id: 'proj-1',
          title: 'SearchableTask Delete',
          description: 'This will be deleted',
        });

        insertTestTask(db, {
          id: 'task-keep-2',
          spec_id: '032-keep2',
          project_id: 'proj-1',
          title: 'SearchableTask Two',
          description: 'Second searchable task',
        });

        // Delete the middle task
        db.prepare('DELETE FROM tasks WHERE id = ?').run('task-delete-mid');

        // Other tasks should still be searchable
        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'SearchableTask'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(2);
        const ids = (results as { id: string }[]).map((r) => r.id);
        expect(ids).toContain('task-keep-1');
        expect(ids).toContain('task-keep-2');
        expect(ids).not.toContain('task-delete-mid');
      });
    });

    describe('FTS5 Search Functionality', () => {
      it('should support prefix search with *', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
        insertTestTask(db, {
          id: 'task-prefix',
          spec_id: '033-prefix',
          project_id: 'proj-1',
          title: 'Authentication Implementation',
          description: 'Implementing auth',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'auth*'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
      });

      it('should support phrase search with quotes', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        insertTestTask(db, {
          id: 'task-phrase-match',
          spec_id: '034-phrase',
          project_id: 'proj-1',
          title: 'User authentication system',
          description: 'Complete system',
        });

        insertTestTask(db, {
          id: 'task-no-match',
          spec_id: '035-nomatch',
          project_id: 'proj-1',
          title: 'Authentication for user management',
          description: 'Different order',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH '"user authentication"'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-phrase-match');
      });

      it('should support AND queries', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        insertTestTask(db, {
          id: 'task-and-match',
          spec_id: '036-and',
          project_id: 'proj-1',
          title: 'User Authentication',
          description: 'Login feature',
        });

        insertTestTask(db, {
          id: 'task-only-user',
          spec_id: '037-user',
          project_id: 'proj-1',
          title: 'User Management',
          description: 'Admin panel',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'user AND authentication'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-and-match');
      });

      it('should support OR queries', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        insertTestTask(db, {
          id: 'task-login',
          spec_id: '038-login',
          project_id: 'proj-1',
          title: 'Login Feature',
          description: 'User login',
        });

        insertTestTask(db, {
          id: 'task-register',
          spec_id: '039-register',
          project_id: 'proj-1',
          title: 'Registration Feature',
          description: 'User signup',
        });

        insertTestTask(db, {
          id: 'task-other',
          spec_id: '040-other',
          project_id: 'proj-1',
          title: 'Dashboard',
          description: 'Main dashboard',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'login OR registration'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(2);
        const ids = (results as { id: string }[]).map((r) => r.id);
        expect(ids).toContain('task-login');
        expect(ids).toContain('task-register');
      });

      it('should support NOT queries', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createFullSchema(db);

        insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });

        insertTestTask(db, {
          id: 'task-auth-backend',
          spec_id: '041-backend',
          project_id: 'proj-1',
          title: 'Auth Backend',
          description: 'Backend implementation',
        });

        insertTestTask(db, {
          id: 'task-auth-frontend',
          spec_id: '042-frontend',
          project_id: 'proj-1',
          title: 'Auth Frontend',
          description: 'Frontend implementation',
        });

        const results = db
          .prepare(
            `
          SELECT t.id FROM tasks t
          JOIN tasks_fts ON t.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'auth NOT frontend'
        `
          )
          .all();
        db.close();

        expect(results).toHaveLength(1);
        expect((results[0] as { id: string }).id).toBe('task-auth-backend');
      });
    });
  });

  describe('Event Queue Triggers', () => {
    it('should create event for task insert', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-event-insert',
        spec_id: '050-event',
        project_id: 'proj-1',
        title: 'Event Test',
      });

      const events = db.prepare('SELECT * FROM event_queue WHERE entity_id = ?').all('task-event-insert');
      db.close();

      const insertEvents = (events as { event_type: string }[]).filter((e) => e.event_type === 'insert');
      expect(insertEvents).toHaveLength(1);
    });

    it('should create event for task update', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-event-update',
        spec_id: '051-event',
        project_id: 'proj-1',
        title: 'Event Test',
      });

      db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Updated', 'task-event-update');

      const events = db.prepare('SELECT * FROM event_queue WHERE entity_id = ?').all('task-event-update');
      db.close();

      const updateEvents = (events as { event_type: string }[]).filter((e) => e.event_type === 'update');
      expect(updateEvents).toHaveLength(1);
    });

    it('should create event for task delete', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-event-delete',
        spec_id: '052-event',
        project_id: 'proj-1',
        title: 'Event Test',
      });

      db.prepare('DELETE FROM tasks WHERE id = ?').run('task-event-delete');

      const events = db.prepare('SELECT * FROM event_queue WHERE entity_id = ?').all('task-event-delete');
      db.close();

      const deleteEvents = (events as { event_type: string }[]).filter((e) => e.event_type === 'delete');
      expect(deleteEvents).toHaveLength(1);
    });
  });

  describe('Trigger Interaction', () => {
    it('should fire all triggers (history, FTS, events) on task insert', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-all-triggers',
        spec_id: '060-all',
        project_id: 'proj-1',
        title: 'AllTriggersTest',
        description: 'Testing all triggers fire',
      });

      // Check history
      const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').all('task-all-triggers');
      expect(history).toHaveLength(1);

      // Check FTS
      const ftsResults = db
        .prepare(
          `
        SELECT t.id FROM tasks t
        JOIN tasks_fts ON t.rowid = tasks_fts.rowid
        WHERE tasks_fts MATCH 'AllTriggersTest'
      `
        )
        .all();
      expect(ftsResults).toHaveLength(1);

      // Check events
      const events = db
        .prepare('SELECT * FROM event_queue WHERE entity_id = ? AND event_type = ?')
        .all('task-all-triggers', 'insert');
      expect(events).toHaveLength(1);

      db.close();
    });

    it('should maintain consistency across all triggers on update', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-consistency',
        spec_id: '061-consistency',
        project_id: 'proj-1',
        title: 'OriginalTitle',
        status: 'backlog',
      });

      db.prepare('DELETE FROM task_history').run();
      db.prepare('DELETE FROM event_queue').run();

      // Update task
      db.prepare('UPDATE tasks SET title = ?, status = ? WHERE id = ?').run(
        'UpdatedTitle',
        'in_progress',
        'task-consistency'
      );

      // Verify history records the change
      const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-consistency') as {
        action: string;
        new_value: string;
      };
      expect(history.action).toBe('status_changed');
      const newValue = JSON.parse(history.new_value);
      expect(newValue.title).toBe('UpdatedTitle');
      expect(newValue.status).toBe('in_progress');

      // Verify FTS is updated
      const ftsOld = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM tasks_fts WHERE tasks_fts MATCH 'OriginalTitle'
      `
        )
        .get() as { count: number };
      const ftsNew = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM tasks_fts WHERE tasks_fts MATCH 'UpdatedTitle'
      `
        )
        .get() as { count: number };
      expect(ftsOld.count).toBe(0);
      expect(ftsNew.count).toBe(1);

      // Verify event is created
      const events = db.prepare('SELECT * FROM event_queue WHERE entity_id = ?').all('task-consistency');
      expect((events as { event_type: string }[]).filter((e) => e.event_type === 'update')).toHaveLength(1);

      db.close();
    });

    it('should clean up FTS and create history on delete', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createFullSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Test', path: '/test' });
      insertTestTask(db, {
        id: 'task-delete-all',
        spec_id: '062-delete',
        project_id: 'proj-1',
        title: 'DeleteAllTriggersTest',
        description: 'Will be deleted',
      });

      db.prepare('DELETE FROM task_history').run();
      db.prepare('DELETE FROM event_queue').run();

      // Delete task
      db.prepare('DELETE FROM tasks WHERE id = ?').run('task-delete-all');

      // Verify history has delete record
      const history = db.prepare('SELECT * FROM task_history WHERE task_id = ?').get('task-delete-all') as {
        action: string;
        old_value: string;
      };
      expect(history.action).toBe('deleted');
      const oldValue = JSON.parse(history.old_value);
      expect(oldValue.title).toBe('DeleteAllTriggersTest');

      // Verify FTS is cleaned up
      const ftsResults = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM tasks_fts WHERE tasks_fts MATCH 'DeleteAllTriggersTest'
      `
        )
        .get() as { count: number };
      expect(ftsResults.count).toBe(0);

      // Verify delete event is created
      const events = db.prepare('SELECT * FROM event_queue WHERE entity_id = ?').all('task-delete-all');
      expect((events as { event_type: string }[]).filter((e) => e.event_type === 'delete')).toHaveLength(1);

      db.close();
    });
  });
});
