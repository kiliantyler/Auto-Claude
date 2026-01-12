/**
 * Unit tests for SearchService
 * Tests FTS5 full-text search operations for tasks
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
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'search-service-test-'));
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
 * Creates the schema needed for search service tests including FTS5 table
 */
function createTestSchema(db: import('better-sqlite3').Database): void {
  // Create tasks table (with rowid)
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

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '003');

    -- FTS5 virtual table for full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      title,
      description,
      tags,
      content='tasks',
      content_rowid='rowid'
    );

    -- Trigger to sync FTS on insert
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

    -- Trigger to sync FTS on update
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

    -- Trigger to sync FTS on delete
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
    created_at?: string;
    updated_at?: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (id, spec_id, project_id, title, description, status, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    task.id,
    task.spec_id,
    task.project_id,
    task.title,
    task.description ?? 'Test description',
    task.status ?? 'backlog',
    task.metadata_json ?? null,
    task.created_at ?? new Date().toISOString(),
    task.updated_at ?? new Date().toISOString()
  );
}

describe('SearchService', () => {
  beforeEach(() => {
    setupTestEnvironment();
    vi.resetModules();
    // Clear ENABLE_SEARCH env var
    delete process.env.ENABLE_SEARCH;
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
    delete process.env.ENABLE_SEARCH;
  });

  describe('constructor and feature flag', () => {
    it('should enable search by default', async () => {
      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      expect(service.isEnabled()).toBe(true);
    });

    it('should disable search when ENABLE_SEARCH is false', async () => {
      process.env.ENABLE_SEARCH = 'false';
      vi.resetModules();

      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      expect(service.isEnabled()).toBe(false);
    });

    it('should enable search for any non-false value', async () => {
      process.env.ENABLE_SEARCH = 'true';
      vi.resetModules();

      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('search', () => {
    it('should return empty result when search is disabled', async () => {
      process.env.ENABLE_SEARCH = 'false';
      vi.resetModules();

      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      const result = service.search({ query: 'test' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should return empty result for empty query', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: '' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return empty result for whitespace-only query', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: '   ' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should find tasks by title', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001-auth',
        project_id: 'proj-1',
        title: 'Implement authentication system',
        description: 'Add user login and registration',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002-dashboard',
        project_id: 'proj-1',
        title: 'Create dashboard page',
        description: 'Build the main dashboard view',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'authentication' });

      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Implement authentication system');
      expect(result.results[0].id).toBe('task-1');
    });

    it('should find tasks by description', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001-test',
        project_id: 'proj-1',
        title: 'Simple task',
        description: 'Implement the authentication flow for users',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'authentication' });

      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('task-1');
    });

    it('should include highlighted results', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001-test',
        project_id: 'proj-1',
        title: 'User authentication feature',
        description: 'Login and logout functionality',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'authentication',
        highlightTags: { open: '<b>', close: '</b>' },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].highlightedTitle).toContain('<b>');
    });

    it('should filter by status', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001-test',
        project_id: 'proj-1',
        title: 'Authentication feature',
        description: 'User auth',
        status: 'backlog',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002-test',
        project_id: 'proj-1',
        title: 'Authentication improvements',
        description: 'Better auth',
        status: 'in_progress',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'authentication',
        filters: { status: ['backlog'] },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].status).toBe('backlog');
    });

    it('should filter by multiple statuses (OR logic)', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth backlog',
        status: 'backlog',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Auth in progress',
        status: 'in_progress',
      });

      insertTestTask(db, {
        id: 'task-3',
        spec_id: '003',
        project_id: 'proj-1',
        title: 'Auth done',
        status: 'done',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { status: ['backlog', 'in_progress'] },
      });

      expect(result.total).toBe(2);
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Project 1 auth task',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-2',
        title: 'Project 2 auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { projectId: 'proj-1' },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].projectId).toBe('proj-1');
    });

    it('should filter by date range', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Old auth task',
        updated_at: '2024-01-01T10:00:00Z',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'New auth task',
        updated_at: '2024-06-15T10:00:00Z',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: {
          dateRange: {
            start: '2024-06-01T00:00:00Z',
            end: '2024-06-30T23:59:59Z',
          },
        },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('task-2');
    });

    it('should filter by category', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth feature',
        metadata_json: JSON.stringify({ category: 'feature' }),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Auth bugfix',
        metadata_json: JSON.stringify({ category: 'bugfix' }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { category: ['feature'] },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].category).toBe('feature');
    });

    it('should filter by priority', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'High priority auth',
        metadata_json: JSON.stringify({ priority: 'high' }),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Low priority auth',
        metadata_json: JSON.stringify({ priority: 'low' }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { priority: ['high'] },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].priority).toBe('high');
    });

    it('should filter by tags', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth with security tag',
        metadata_json: JSON.stringify({ tags: ['security', 'auth'] }),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Auth with ui tag',
        metadata_json: JSON.stringify({ tags: ['ui', 'auth'] }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { tags: ['security'] },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('task-1');
    });

    it('should exclude archived tasks by default', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Active auth task',
        metadata_json: JSON.stringify({}),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Archived auth task',
        metadata_json: JSON.stringify({ archivedAt: '2024-01-01' }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth' });

      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('task-1');
    });

    it('should include archived tasks when excludeArchived is false', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Active auth task',
        metadata_json: JSON.stringify({}),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Archived auth task',
        metadata_json: JSON.stringify({ archivedAt: '2024-01-01' }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { excludeArchived: false },
      });

      expect(result.total).toBe(2);
    });

    it('should respect limit option', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert 10 tasks
      for (let i = 0; i < 10; i++) {
        insertTestTask(db, {
          id: `task-${i}`,
          spec_id: `00${i}`,
          project_id: 'proj-1',
          title: `Auth task ${i}`,
        });
      }
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth', limit: 5 });

      expect(result.results).toHaveLength(5);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(true);
    });

    it('should respect offset option for pagination', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      for (let i = 0; i < 10; i++) {
        insertTestTask(db, {
          id: `task-${i}`,
          spec_id: `00${i}`,
          project_id: 'proj-1',
          title: `Auth task ${i}`,
        });
      }
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth', limit: 5, offset: 5 });

      expect(result.results).toHaveLength(5);
      expect(result.total).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it('should sort by relevance by default', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Authentication',
        description: 'Simple description',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'User authentication system',
        description: 'Complete authentication implementation',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'authentication' });

      expect(result.results.length).toBeGreaterThanOrEqual(1);
      // Results should have score property
      result.results.forEach((r) => {
        expect(r.score).toBeDefined();
        expect(typeof r.score).toBe('number');
      });
    });

    it('should sort by date descending', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Old auth task',
        updated_at: '2024-01-01T10:00:00Z',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'New auth task',
        updated_at: '2024-06-01T10:00:00Z',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth', sort: 'date_desc' });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('task-2'); // Newer first
    });

    it('should sort by date ascending', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Old auth task',
        updated_at: '2024-01-01T10:00:00Z',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'New auth task',
        updated_at: '2024-06-01T10:00:00Z',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth', sort: 'date_asc' });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('task-1'); // Older first
    });

    it('should sort by title ascending', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Zebra auth task',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Alpha auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'auth', sort: 'title_asc' });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].id).toBe('task-2'); // Alpha first
    });

    it('should handle FTS5 special characters in query', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Test with special chars',
        description: 'Description for testing',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      // These should not cause FTS5 syntax errors
      const result1 = service.search({ query: 'test+chars' });
      const result2 = service.search({ query: 'test-chars' });
      const result3 = service.search({ query: 'test:chars' });
      const result4 = service.search({ query: '"quoted"' });

      // Should not throw errors
      expect(result1.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(result2.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(result3.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(result4.searchTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should allow explicit FTS5 operators (AND, OR, NOT)', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'User authentication',
        description: 'Login feature',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'User registration',
        description: 'Signup feature',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'user AND authentication' });

      expect(result.total).toBe(1);
      expect(result.results[0].title).toBe('User authentication');
    });

    it('should add search to recent searches', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      service.search({ query: 'auth' });
      const recentSearches = service.getRecentSearches();

      expect(recentSearches).toHaveLength(1);
      expect(recentSearches[0].query).toBe('auth');
      expect(recentSearches[0].resultCount).toBe(1);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema - this will cause an error
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'test' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should return correct matchedFields', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Authentication feature',
        description: 'Login and logout for authentication',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'authentication' });

      expect(result.results[0].matchedFields).toContain('title');
      expect(result.results[0].matchedFields).toContain('description');
    });

    it('should parse metadata fields correctly', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Complex task',
        metadata_json: JSON.stringify({
          category: 'feature',
          priority: 'high',
          complexity: 'complex',
          tags: ['auth', 'security'],
        }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'complex' });

      expect(result.results[0].category).toBe('feature');
      expect(result.results[0].priority).toBe('high');
      expect(result.results[0].complexity).toBe('complex');
      expect(result.results[0].tags).toEqual(['auth', 'security']);
    });
  });

  describe('getSuggestions', () => {
    it('should return empty when search is disabled', async () => {
      process.env.ENABLE_SEARCH = 'false';
      vi.resetModules();

      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'test' });

      expect(result.suggestions).toEqual([]);
    });

    it('should return task title suggestions', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Authentication feature',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'auth' });

      const taskSuggestions = result.suggestions.filter((s) => s.type === 'task');
      expect(taskSuggestions.length).toBeGreaterThan(0);
      expect(taskSuggestions[0].text).toBe('Authentication feature');
      expect(taskSuggestions[0].taskId).toBe('task-1');
    });

    it('should return tag suggestions', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task with tags',
        metadata_json: JSON.stringify({ tags: ['authentication', 'security'] }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'auth' });

      const tagSuggestions = result.suggestions.filter((s) => s.type === 'tag');
      expect(tagSuggestions.length).toBeGreaterThan(0);
      expect(tagSuggestions[0].text).toBe('authentication');
    });

    it('should return status suggestions when query matches status', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Some task',
        status: 'backlog',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'back' });

      const statusSuggestions = result.suggestions.filter((s) => s.type === 'status');
      expect(statusSuggestions.length).toBeGreaterThan(0);
      expect(statusSuggestions[0].text).toBe('status:backlog');
    });

    it('should include recent search suggestions', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Authentication task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      // Perform a search first to add to recent
      service.search({ query: 'authentication' });

      const result = service.getSuggestions({ query: 'auth' });

      const recentSuggestions = result.suggestions.filter((s) => s.type === 'recent');
      expect(recentSuggestions.length).toBeGreaterThan(0);
      expect(recentSuggestions[0].text).toBe('authentication');
    });

    it('should respect limit option', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      for (let i = 0; i < 20; i++) {
        insertTestTask(db, {
          id: `task-${i}`,
          spec_id: `00${i}`,
          project_id: 'proj-1',
          title: `Auth task ${i}`,
        });
      }
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'auth', limit: 5 });

      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task project 1',
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-2',
        title: 'Auth task project 2',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'auth', projectId: 'proj-1' });

      const taskSuggestions = result.suggestions.filter((s) => s.type === 'task');
      expect(taskSuggestions).toHaveLength(1);
      expect(taskSuggestions[0].text).toBe('Auth task project 1');
    });

    it('should exclude recent searches when includeRecent is false', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Authentication task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      // Perform a search first
      service.search({ query: 'authentication' });

      const result = service.getSuggestions({ query: 'auth', includeRecent: false });

      const recentSuggestions = result.suggestions.filter((s) => s.type === 'recent');
      expect(recentSuggestions).toHaveLength(0);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'test' });

      expect(result.suggestions).toEqual([]);
    });

    it('should require at least 2 characters for title search', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'A task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getSuggestions({ query: 'A' });

      // No task suggestions for single character query
      const taskSuggestions = result.suggestions.filter((s) => s.type === 'task');
      expect(taskSuggestions).toHaveLength(0);
    });
  });

  describe('getRecentSearches', () => {
    it('should return empty array when no searches performed', async () => {
      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.getRecentSearches();

      expect(result).toEqual([]);
    });

    it('should return recent searches in order', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task one two three',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      service.search({ query: 'one' });
      service.search({ query: 'two' });
      service.search({ query: 'three' });

      const result = service.getRecentSearches();

      expect(result).toHaveLength(3);
      expect(result[0].query).toBe('three'); // Most recent first
      expect(result[2].query).toBe('one');
    });

    it('should respect limit parameter', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      for (let i = 0; i < 10; i++) {
        service.search({ query: `search${i}` });
      }

      const result = service.getRecentSearches(5);

      expect(result).toHaveLength(5);
    });

    it('should not duplicate recent searches', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      service.search({ query: 'auth' });
      service.search({ query: 'auth' });
      service.search({ query: 'auth' });

      const result = service.getRecentSearches();

      expect(result).toHaveLength(1);
      expect(result[0].query).toBe('auth');
    });
  });

  describe('clearRecentSearches', () => {
    it('should clear all recent searches', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Auth task',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      service.search({ query: 'auth' });
      expect(service.getRecentSearches()).toHaveLength(1);

      service.clearRecentSearches();

      expect(service.getRecentSearches()).toEqual([]);
    });
  });

  describe('rebuildIndex', () => {
    it('should not throw when search is disabled', async () => {
      process.env.ENABLE_SEARCH = 'false';
      vi.resetModules();

      const { SearchService } = await import('../search-service');
      const service = new SearchService();

      expect(() => service.rebuildIndex()).not.toThrow();
    });

    it('should rebuild FTS5 index', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      // Should not throw
      expect(() => service.rebuildIndex()).not.toThrow();
    });

    it('should throw error if database has issues', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      // Don't create FTS5 table
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      expect(() => service.rebuildIndex()).toThrow();
    });
  });

  describe('verifyFts5Available', () => {
    it('should return true when FTS5 is available', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.verifyFts5Available();

      // better-sqlite3 typically has FTS5 enabled
      expect(result).toBe(true);
    });
  });

  describe('singleton pattern', () => {
    it('should return the same instance from getSearchService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getSearchService, resetSearchService } = await import('../search-service');
      resetSearchService();

      const instance1 = getSearchService();
      const instance2 = getSearchService();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after resetSearchService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getSearchService, resetSearchService } = await import('../search-service');
      resetSearchService();

      const instance1 = getSearchService();
      resetSearchService();
      const instance2 = getSearchService();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('rowToResult conversion', () => {
    it('should handle null metadata_json', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task without metadata',
        metadata_json: undefined,
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'metadata' });

      expect(result.results[0].category).toBeUndefined();
      expect(result.results[0].priority).toBeUndefined();
      expect(result.results[0].tags).toBeUndefined();
    });

    it('should handle invalid JSON in metadata_json', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert directly with invalid JSON
      db.prepare(`
        INSERT INTO tasks (id, spec_id, project_id, title, description, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('task-1', '001', 'proj-1', 'Task with bad json', 'Description', 'backlog', 'not valid json');

      // Manually insert into FTS
      db.prepare(`
        INSERT INTO tasks_fts(rowid, title, description, tags)
        SELECT rowid, title, description, NULL FROM tasks WHERE id = ?
      `).run('task-1');

      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'bad' });

      // Should not throw, just have undefined metadata
      expect(result.results[0].category).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty database', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'anything' });

      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should cap limit at 100', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      for (let i = 0; i < 150; i++) {
        insertTestTask(db, {
          id: `task-${i}`,
          spec_id: `${String(i).padStart(3, '0')}`,
          project_id: 'proj-1',
          title: `Test task ${i}`,
        });
      }
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'test', limit: 200 });

      expect(result.results.length).toBeLessThanOrEqual(100);
    });

    it('should search by tags in FTS', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Simple task',
        description: 'Simple description',
        metadata_json: JSON.stringify({ tags: ['uniquetagname'] }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({ query: 'uniquetagname' });

      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('task-1');
    });

    it('should limit recent searches to MAX_RECENT_SEARCHES', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task for recent searches test',
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      // Perform more than MAX_RECENT_SEARCHES searches
      for (let i = 0; i < 25; i++) {
        service.search({ query: `query${i}` });
      }

      const result = service.getRecentSearches(100); // Request more than max

      expect(result.length).toBeLessThanOrEqual(20); // MAX_RECENT_SEARCHES = 20
    });

    it('should filter by complexity', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Simple auth',
        metadata_json: JSON.stringify({ complexity: 'simple' }),
      });

      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Complex auth',
        metadata_json: JSON.stringify({ complexity: 'complex' }),
      });
      db.close();

      const { SearchService, resetSearchService } = await import('../search-service');
      resetSearchService();
      const service = new SearchService();

      const result = service.search({
        query: 'auth',
        filters: { complexity: ['simple'] },
      });

      expect(result.total).toBe(1);
      expect(result.results[0].complexity).toBe('simple');
    });
  });
});
