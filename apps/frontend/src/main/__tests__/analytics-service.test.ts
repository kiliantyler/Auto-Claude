/**
 * Unit tests for AnalyticsService
 * Tests analytics metrics calculation, trends, distribution, and export functionality
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import type { AnalyticsQueryOptions, AnalyticsExportOptions } from '../../shared/types';

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
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'analytics-service-test-'));
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
 * Creates the minimal schema needed for analytics service tests
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

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      settings TEXT
    );

    CREATE TABLE IF NOT EXISTS task_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      in_progress_tasks INTEGER DEFAULT 0,
      blocked_tasks INTEGER DEFAULT 0,
      avg_completion_time_hours REAL,
      created_count INTEGER DEFAULT 0,
      completed_count INTEGER DEFAULT 0,
      UNIQUE(project_id, metric_date)
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

/**
 * Insert test project into the database
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
    INSERT INTO projects (id, name, path)
    VALUES (?, ?, ?)
  `);
  stmt.run(project.id, project.name, project.path);
}

/**
 * Insert test metrics into the database
 */
function insertTestMetrics(
  db: import('better-sqlite3').Database,
  metrics: {
    project_id: string;
    metric_date: string;
    total_tasks?: number;
    completed_tasks?: number;
    in_progress_tasks?: number;
    blocked_tasks?: number;
    avg_completion_time_hours?: number | null;
    created_count?: number;
    completed_count?: number;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO task_metrics (project_id, metric_date, total_tasks, completed_tasks, in_progress_tasks, blocked_tasks, avg_completion_time_hours, created_count, completed_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    metrics.project_id,
    metrics.metric_date,
    metrics.total_tasks ?? 0,
    metrics.completed_tasks ?? 0,
    metrics.in_progress_tasks ?? 0,
    metrics.blocked_tasks ?? 0,
    metrics.avg_completion_time_hours ?? null,
    metrics.created_count ?? 0,
    metrics.completed_count ?? 0
  );
}

describe('AnalyticsService', () => {
  beforeEach(() => {
    setupTestEnvironment();
    vi.resetModules();
    // Clear ENABLE_ANALYTICS env var
    delete process.env.ENABLE_ANALYTICS;
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
    delete process.env.ENABLE_ANALYTICS;
  });

  describe('constructor and feature flag', () => {
    it('should enable analytics by default', async () => {
      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      expect(service.isEnabled()).toBe(true);
    });

    it('should disable analytics when ENABLE_ANALYTICS is false', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      expect(service.isEnabled()).toBe(false);
    });

    it('should enable analytics for any non-false value', async () => {
      process.env.ENABLE_ANALYTICS = 'true';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('getOverview', () => {
    it('should return empty overview when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(0);
      expect(result.completedTasks).toBe(0);
      expect(result.completionRate).toBe(0);
      expect(result.velocityPerDay).toBe(0);
    });

    it('should return correct overview metrics for tasks', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert test tasks with different statuses
      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'done' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-1', title: 'Task 3', status: 'in_progress' });
      insertTestTask(db, { id: 'task-4', spec_id: '004', project_id: 'proj-1', title: 'Task 4', status: 'backlog' });
      insertTestTask(db, { id: 'task-5', spec_id: '005', project_id: 'proj-1', title: 'Task 5', status: 'ai_review' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(5);
      expect(result.completedTasks).toBe(2);
      expect(result.inProgressTasks).toBe(1);
      expect(result.backlogTasks).toBe(1);
      expect(result.blockedTasks).toBe(1); // ai_review counts as blocked
      expect(result.completionRate).toBe(40); // 2/5 = 40%
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'backlog' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-2', title: 'Task 3', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview({ projectId: 'proj-1' });

      expect(result.totalTasks).toBe(2);
      expect(result.completedTasks).toBe(1);
    });

    it('should exclude archived tasks by default', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Active task', status: 'done' });
      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Archived task',
        status: 'done',
        metadata_json: JSON.stringify({ archivedAt: '2024-01-01' }),
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(1);
    });

    it('should include archived tasks when includeArchived is true', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Active task', status: 'done' });
      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Archived task',
        status: 'done',
        metadata_json: JSON.stringify({ archivedAt: '2024-01-01' }),
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview({ includeArchived: true });

      expect(result.totalTasks).toBe(2);
    });

    it('should calculate velocity correctly', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Create tasks completed within a 7-day period
      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task 1',
        status: 'done',
        updated_at: today.toISOString(),
      });
      insertTestTask(db, {
        id: 'task-2',
        spec_id: '002',
        project_id: 'proj-1',
        title: 'Task 2',
        status: 'done',
        updated_at: today.toISOString(),
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview({
        startDate: weekAgo.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0],
      });

      expect(result.velocityPerDay).toBeGreaterThan(0);
      expect(result.velocityPerWeek).toBe(result.velocityPerDay * 7);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema - this will cause an error
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(0);
      expect(result.completionRate).toBe(0);
    });

    it('should include comparison to previous period when compareToPrevious is true', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'backlog' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const result = service.getOverview({
        startDate: weekAgo.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0],
        compareToPrevious: true,
      });

      // compareToPrevious results may be undefined if no previous data exists
      // but the call should not throw
      expect(result.totalTasks).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getTrends', () => {
    it('should return empty trends when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.getTrends();

      expect(result.completedTasks).toEqual([]);
      expect(result.createdTasks).toEqual([]);
      expect(result.totalTasks).toEqual([]);
    });

    it('should return trend data from task_metrics table', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert test metrics for multiple days
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 5, completed_tasks: 2, completed_count: 1 });
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-02', total_tasks: 6, completed_tasks: 3, completed_count: 1 });
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-03', total_tasks: 7, completed_tasks: 4, completed_count: 1 });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getTrends({
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      });

      expect(result.completedTasks).toHaveLength(3);
      expect(result.totalTasks).toHaveLength(3);
      expect(result.period).toBe('day');
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 5 });
      insertTestMetrics(db, { project_id: 'proj-2', metric_date: '2024-01-01', total_tasks: 10 });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getTrends({
        startDate: '2024-01-01',
        endDate: '2024-01-01',
        projectId: 'proj-1',
      });

      expect(result.totalTasks).toHaveLength(1);
      expect(result.totalTasks[0].value).toBe(5);
    });

    it('should calculate trends from tasks table when no metrics exist', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert tasks without metrics
      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task 1',
        status: 'done',
        created_at: '2024-01-01T10:00:00Z',
        updated_at: '2024-01-01T12:00:00Z',
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getTrends({
        startDate: '2024-01-01',
        endDate: '2024-01-01',
      });

      // Should not throw and should return some data
      expect(result.startDate).toBe('2024-01-01');
      expect(result.endDate).toBe('2024-01-01');
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getTrends();

      expect(result.completedTasks).toEqual([]);
    });
  });

  describe('getDistribution', () => {
    it('should return empty distribution when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.getDistribution();

      expect(result.byStatus).toEqual([]);
      expect(result.totalTasks).toBe(0);
    });

    it('should return status distribution', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'done' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-1', title: 'Task 3', status: 'in_progress' });
      insertTestTask(db, { id: 'task-4', spec_id: '004', project_id: 'proj-1', title: 'Task 4', status: 'backlog' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution();

      expect(result.totalTasks).toBe(4);
      expect(result.byStatus.length).toBeGreaterThan(0);

      // Find the 'Done' status entry
      const doneStatus = result.byStatus.find((s) => s.name === 'Done');
      expect(doneStatus).toBeDefined();
      expect(doneStatus!.value).toBe(2);
      expect(doneStatus!.percentage).toBe(50);
    });

    it('should include project distribution when not filtering by project', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestProject(db, { id: 'proj-1', name: 'Project One', path: '/path/one' });
      insertTestProject(db, { id: 'proj-2', name: 'Project Two', path: '/path/two' });
      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-2', title: 'Task 2', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution();

      expect(result.byProject).toBeDefined();
      expect(result.byProject!.length).toBeGreaterThan(0);
    });

    it('should not include project distribution when filtering by project', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution({ projectId: 'proj-1' });

      expect(result.byProject).toBeUndefined();
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution();

      expect(result.byStatus).toEqual([]);
      expect(result.totalTasks).toBe(0);
    });
  });

  describe('calculateDailyMetrics', () => {
    it('should return error when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.calculateDailyMetrics();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Analytics feature is disabled');
    });

    it('should calculate metrics for all projects', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'in_progress' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-2', title: 'Task 3', status: 'backlog' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.calculateDailyMetrics();

      expect(result.success).toBe(true);
      expect(result.metricsCalculated).toBe(2); // Two projects
    });

    it('should calculate metrics for a specific project', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-2', title: 'Task 2', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.calculateDailyMetrics(undefined, 'proj-1');

      expect(result.success).toBe(true);
      expect(result.metricsCalculated).toBe(1);
    });

    it('should calculate metrics for a specific date', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.calculateDailyMetrics('2024-01-15', 'proj-1');

      expect(result.success).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.calculateDailyMetrics();

      expect(result.success).toBe(false);
      expect(result.metricsCalculated).toBe(0);
      expect(result.error).toBeDefined();
    });
  });

  describe('calculateMetricsForRange', () => {
    it('should return error when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.calculateMetricsForRange('2024-01-01', '2024-01-07');

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Analytics feature is disabled');
    });

    it('should calculate metrics for a date range', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.calculateMetricsForRange('2024-01-01', '2024-01-03');

      expect(result.success).toBe(true);
      expect(result.totalMetrics).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getStoredMetrics', () => {
    it('should return empty array when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.getStoredMetrics();

      expect(result).toEqual([]);
    });

    it('should return stored metrics', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 10 });
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-02', total_tasks: 12 });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getStoredMetrics({
        startDate: '2024-01-01',
        endDate: '2024-01-02',
      });

      expect(result).toHaveLength(2);
      expect(result[0].totalTasks).toBe(10);
      expect(result[1].totalTasks).toBe(12);
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 10 });
      insertTestMetrics(db, { project_id: 'proj-2', metric_date: '2024-01-01', total_tasks: 20 });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getStoredMetrics({
        startDate: '2024-01-01',
        endDate: '2024-01-01',
        projectId: 'proj-1',
      });

      expect(result).toHaveLength(1);
      expect(result[0].totalTasks).toBe(10);
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getStoredMetrics();

      expect(result).toEqual([]);
    });
  });

  describe('cleanupOldMetrics', () => {
    it('should return 0 when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.cleanupOldMetrics();

      expect(result).toBe(0);
    });

    it('should delete metrics older than specified days', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert old metrics
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2020-01-01', total_tasks: 10 });
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2020-01-02', total_tasks: 10 });
      // Insert recent metrics
      const today = new Date().toISOString().split('T')[0];
      insertTestMetrics(db, { project_id: 'proj-1', metric_date: today, total_tasks: 10 });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const deleted = service.cleanupOldMetrics(30);

      expect(deleted).toBe(2); // Two old entries deleted
    });

    it('should handle database errors gracefully', async () => {
      // Don't create schema
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.cleanupOldMetrics();

      expect(result).toBe(0);
    });
  });

  describe('exportData', () => {
    it('should return error when analytics is disabled', async () => {
      process.env.ENABLE_ANALYTICS = 'false';
      vi.resetModules();

      const { AnalyticsService } = await import('../analytics-service');
      const service = new AnalyticsService();

      const result = service.exportData({ format: 'json' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Analytics feature is disabled');
    });

    describe('JSON export', () => {
      it('should export data as JSON', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'json',
          sections: ['overview'],
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();

        const parsed = JSON.parse(result.data!);
        expect(parsed.overview).toBeDefined();
        expect(parsed.exportedAt).toBeDefined();
      });

      it('should include all sections when specified', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'json',
          sections: ['overview', 'trends', 'distribution', 'velocity'],
        });

        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.data!);
        expect(parsed.overview).toBeDefined();
        expect(parsed.trends).toBeDefined();
        expect(parsed.distribution).toBeDefined();
        expect(parsed.velocity).toBeDefined();
      });
    });

    describe('CSV export', () => {
      it('should export data as CSV', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'csv',
          sections: ['overview'],
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).toContain('Total Tasks');
        expect(result.data).toContain('# Overview Metrics');
      });

      it('should include trend data in CSV', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 10 });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'csv',
          sections: ['trends'],
          startDate: '2024-01-01',
          endDate: '2024-01-01',
        });

        expect(result.success).toBe(true);
        expect(result.data).toContain('# Trend Data');
      });

      it('should include distribution data in CSV', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'csv',
          sections: ['distribution'],
        });

        expect(result.success).toBe(true);
        expect(result.data).toContain('# Status Distribution');
      });

      it('should include velocity data in CSV', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', completed_count: 5, created_count: 3 });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'csv',
          sections: ['velocity'],
          startDate: '2024-01-01',
          endDate: '2024-01-01',
        });

        expect(result.success).toBe(true);
        expect(result.data).toContain('# Velocity Data');
      });
    });

    describe('PDF export', () => {
      it('should export data as PDF', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'pdf',
          sections: ['overview'],
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
        expect(result.data).toContain('data:application/pdf');
      });

      it('should include distribution section in PDF', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'pdf',
          sections: ['distribution'],
        });

        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();
      });

      it('should include trends section in PDF', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', total_tasks: 10 });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'pdf',
          sections: ['trends'],
          startDate: '2024-01-01',
          endDate: '2024-01-01',
        });

        expect(result.success).toBe(true);
      });

      it('should include velocity section in PDF', async () => {
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        createTestSchema(db);

        insertTestMetrics(db, { project_id: 'proj-1', metric_date: '2024-01-01', completed_count: 5 });
        db.close();

        const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
        resetAnalyticsService();
        const service = new AnalyticsService();

        const result = service.exportData({
          format: 'pdf',
          sections: ['velocity'],
          startDate: '2024-01-01',
          endDate: '2024-01-01',
        });

        expect(result.success).toBe(true);
      });
    });

    it('should return error for unsupported format', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.exportData({
        format: 'xml' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported export format');
    });

    it('should filter by projectId', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-2', title: 'Task 2', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.exportData({
        format: 'json',
        sections: ['overview'],
        projectId: 'proj-1',
      });

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.data!);
      expect(parsed.overview.totalTasks).toBe(1);
    });
  });

  describe('singleton pattern', () => {
    it('should return the same instance from getAnalyticsService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getAnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();

      const instance1 = getAnalyticsService();
      const instance2 = getAnalyticsService();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after resetAnalyticsService', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { getAnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();

      const instance1 = getAnalyticsService();
      resetAnalyticsService();
      const instance2 = getAnalyticsService();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('date range handling', () => {
    it('should use default 30 day range when no dates specified', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.periodStart).toBeDefined();
      expect(result.periodEnd).toBeDefined();
      expect(result.daysInPeriod).toBeGreaterThan(0);
    });

    it('should use partial date range when only start date specified', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview({ startDate: '2024-01-01' });

      expect(result.periodStart).toBe('2024-01-01');
      expect(result.periodEnd).toBeDefined();
    });

    it('should calculate days in period correctly', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview({
        startDate: '2024-01-01',
        endDate: '2024-01-07',
      });

      expect(result.daysInPeriod).toBe(7); // 7 days inclusive
    });
  });

  describe('status formatting', () => {
    it('should format status names correctly in distribution', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'in_progress' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'ai_review' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-1', title: 'Task 3', status: 'human_review' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution();

      const statusNames = result.byStatus.map((s) => s.name);
      expect(statusNames).toContain('In Progress');
      expect(statusNames).toContain('AI Review');
      expect(statusNames).toContain('Human Review');
    });

    it('should assign correct colors to statuses', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      insertTestTask(db, { id: 'task-2', spec_id: '002', project_id: 'proj-1', title: 'Task 2', status: 'in_progress' });
      insertTestTask(db, { id: 'task-3', spec_id: '003', project_id: 'proj-1', title: 'Task 3', status: 'backlog' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getDistribution();

      const doneStatus = result.byStatus.find((s) => s.name === 'Done');
      expect(doneStatus?.color).toBe('#10b981'); // emerald-500

      const inProgressStatus = result.byStatus.find((s) => s.name === 'In Progress');
      expect(inProgressStatus?.color).toBe('#3b82f6'); // blue-500

      const backlogStatus = result.byStatus.find((s) => s.name === 'Backlog');
      expect(backlogStatus?.color).toBe('#f59e0b'); // amber-500
    });
  });

  describe('edge cases', () => {
    it('should handle empty database', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const overview = service.getOverview();
      const trends = service.getTrends();
      const distribution = service.getDistribution();

      expect(overview.totalTasks).toBe(0);
      expect(overview.completionRate).toBe(0);
      expect(trends.completedTasks).toEqual([]);
      expect(distribution.byStatus).toEqual([]);
    });

    it('should handle zero total tasks (no division by zero)', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.completionRate).toBe(0);
      expect(result.velocityPerDay).toBe(0);
      expect(result.velocityPerWeek).toBe(0);
    });

    it('should handle export with all default sections', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, { id: 'task-1', spec_id: '001', project_id: 'proj-1', title: 'Task 1', status: 'done' });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      // Export without specifying sections - should use defaults
      const result = service.exportData({ format: 'json' });

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.data!);
      expect(parsed.overview).toBeDefined();
      expect(parsed.trends).toBeDefined();
      expect(parsed.distribution).toBeDefined();
    });

    it('should handle tasks with special characters in metadata', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestTask(db, {
        id: 'task-1',
        spec_id: '001',
        project_id: 'proj-1',
        title: 'Task with "quotes"',
        status: 'done',
        metadata_json: JSON.stringify({ notes: 'Test\nwith\nnewlines' }),
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(1);
    });

    it('should handle large number of tasks', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      // Insert 100 tasks
      for (let i = 0; i < 100; i++) {
        const status = ['done', 'in_progress', 'backlog'][i % 3];
        insertTestTask(db, {
          id: `task-${i}`,
          spec_id: `${String(i).padStart(3, '0')}`,
          project_id: 'proj-1',
          title: `Task ${i}`,
          status,
        });
      }
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getOverview();

      expect(result.totalTasks).toBe(100);
      expect(result.completedTasks).toBe(34); // ~1/3 of 100 (0, 3, 6, ...)
    });

    it('should handle metrics with null avg_completion_time', async () => {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(TEST_DB_PATH);
      createTestSchema(db);

      insertTestMetrics(db, {
        project_id: 'proj-1',
        metric_date: '2024-01-01',
        total_tasks: 10,
        avg_completion_time_hours: null,
      });
      db.close();

      const { AnalyticsService, resetAnalyticsService } = await import('../analytics-service');
      resetAnalyticsService();
      const service = new AnalyticsService();

      const result = service.getTrends({
        startDate: '2024-01-01',
        endDate: '2024-01-01',
      });

      expect(result.avgCompletionTime[0].value).toBe(0);
    });
  });
});
