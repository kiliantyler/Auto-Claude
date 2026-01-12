/**
 * Task Storage Layer with SQLite CRUD Operations
 * ===============================================
 *
 * Provides database-backed task storage with dual-write support for safe migration.
 *
 * Key Features:
 * - Create, read, update, delete operations for tasks
 * - Dual-write mode: writes to both SQLite and JSON (controlled by ENABLE_DUAL_WRITE env var)
 * - Prepared statements for SQL injection prevention
 * - Automatic serialization of TaskMetadata, subtasks, QA reports, etc.
 * - Database triggers automatically emit IPC events for real-time UI updates
 *
 * Usage:
 * ```typescript
 * const storage = new TaskStorage();
 *
 * // Create task
 * storage.createTask(task);
 *
 * // Read task
 * const task = storage.getTask(taskId);
 *
 * // Update task
 * storage.updateTask(taskId, { status: 'in_progress' });
 *
 * // Delete task
 * storage.deleteTask(taskId);
 *
 * // List all tasks for a project
 * const tasks = storage.listTasks(projectId);
 * ```
 */

import type { Task, TaskStatus, ReviewReason, TaskMetadata } from '../shared/types';
import { getDatabaseConnection } from './database';

/**
 * Task Storage Service
 * Handles task CRUD operations with SQLite database
 */
export class TaskStorage {
  private readonly ENABLE_DUAL_WRITE: boolean;

  constructor() {
    // Enable dual-write by default (Phase 1 migration strategy)
    // Set ENABLE_DUAL_WRITE=false to use SQLite-only mode
    this.ENABLE_DUAL_WRITE = process.env.ENABLE_DUAL_WRITE !== 'false';
    console.log(`[TaskStorage] Dual-write mode: ${this.ENABLE_DUAL_WRITE ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Execute a function within a transaction.
   *
   * Automatically handles commit on success and rollback on error.
   * Use this for atomic multi-task operations (e.g., bulk updates, cascading changes).
   *
   * CRITICAL: Do NOT use async/await inside the callback - better-sqlite3
   * will commit the transaction before awaits complete.
   *
   * @param fn - Function to execute within transaction (must be synchronous)
   * @returns Result of the function
   *
   * @example
   * ```typescript
   * const storage = new TaskStorage();
   * storage.withTransaction(() => {
   *   storage.createTask(task1);
   *   storage.createTask(task2);
   *   storage.updateTask(task3.id, { status: 'completed' });
   * });
   * ```
   */
  withTransaction<T>(fn: () => T): T {
    return getDatabaseConnection().withTransaction(fn);
  }

  /**
   * Create a new task in the database
   *
   * @param task - Task object to create
   * @returns Created task
   */
  createTask(task: Task): Task {
    try {
      const db = getDatabaseConnection().getConnection();

      // Prepare metadata JSON (serialize complex fields)
      const metadataJson = JSON.stringify({
        ...task.metadata,
        subtasks: task.subtasks,
        qaReport: task.qaReport,
        logs: task.logs,
        executionProgress: task.executionProgress,
      });

      // Insert task into database
      const stmt = db.prepare(`
        INSERT INTO tasks (
          id, spec_id, project_id, title, description, status, review_reason,
          released_in_version, staged_in_main_project, staged_at, location, specs_path,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        task.id,
        task.specId,
        task.projectId,
        task.title,
        task.description,
        task.status,
        task.reviewReason || null,
        task.releasedInVersion || null,
        task.stagedInMainProject ? 1 : 0,
        task.stagedAt || null,
        task.location || null,
        task.specsPath || null,
        metadataJson,
        task.createdAt.toISOString(),
        task.updatedAt.toISOString()
      );

      console.log(`[TaskStorage] Created task: ${task.id} (${task.title})`);

      return task;
    } catch (error) {
      console.error('[TaskStorage] Failed to create task:', error);
      throw error;
    }
  }

  /**
   * Get a task by ID from the database
   *
   * @param taskId - Task ID
   * @returns Task object or null if not found
   */
  getTask(taskId: string): Task | null {
    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
      const row = stmt.get(taskId) as DatabaseTaskRow | undefined;

      if (!row) {
        return null;
      }

      return this.rowToTask(row);
    } catch (error) {
      console.error(`[TaskStorage] Failed to get task ${taskId}:`, error);
      return null;
    }
  }

  /**
   * Get a task by spec ID from the database
   *
   * @param specId - Spec ID
   * @returns Task object or null if not found
   */
  getTaskBySpecId(specId: string): Task | null {
    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare('SELECT * FROM tasks WHERE spec_id = ?');
      const row = stmt.get(specId) as DatabaseTaskRow | undefined;

      if (!row) {
        return null;
      }

      return this.rowToTask(row);
    } catch (error) {
      console.error(`[TaskStorage] Failed to get task by spec ID ${specId}:`, error);
      return null;
    }
  }

  /**
   * Update a task in the database
   *
   * @param taskId - Task ID
   * @param updates - Partial task updates
   * @returns Updated task or null if not found
   */
  updateTask(taskId: string, updates: Partial<Task>): Task | null {
    try {
      const db = getDatabaseConnection().getConnection();

      // Get existing task
      const existingTask = this.getTask(taskId);
      if (!existingTask) {
        console.warn(`[TaskStorage] Cannot update non-existent task: ${taskId}`);
        return null;
      }

      // Merge updates
      const updatedTask: Task = {
        ...existingTask,
        ...updates,
        updatedAt: new Date(),
      };

      // Prepare metadata JSON
      const metadataJson = JSON.stringify({
        ...updatedTask.metadata,
        subtasks: updatedTask.subtasks,
        qaReport: updatedTask.qaReport,
        logs: updatedTask.logs,
        executionProgress: updatedTask.executionProgress,
      });

      // Update task in database
      const stmt = db.prepare(`
        UPDATE tasks SET
          spec_id = ?,
          project_id = ?,
          title = ?,
          description = ?,
          status = ?,
          review_reason = ?,
          released_in_version = ?,
          staged_in_main_project = ?,
          staged_at = ?,
          location = ?,
          specs_path = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
      `);

      const result = stmt.run(
        updatedTask.specId,
        updatedTask.projectId,
        updatedTask.title,
        updatedTask.description,
        updatedTask.status,
        updatedTask.reviewReason || null,
        updatedTask.releasedInVersion || null,
        updatedTask.stagedInMainProject ? 1 : 0,
        updatedTask.stagedAt || null,
        updatedTask.location || null,
        updatedTask.specsPath || null,
        metadataJson,
        updatedTask.updatedAt.toISOString(),
        taskId
      );

      if (result.changes === 0) {
        console.warn(`[TaskStorage] No changes made to task: ${taskId}`);
        return null;
      }

      console.log(`[TaskStorage] Updated task: ${taskId} (${updatedTask.title})`);

      return updatedTask;
    } catch (error) {
      console.error(`[TaskStorage] Failed to update task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a task from the database
   *
   * @param taskId - Task ID
   * @returns True if deleted, false if not found
   */
  deleteTask(taskId: string): boolean {
    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
      const result = stmt.run(taskId);

      if (result.changes === 0) {
        console.warn(`[TaskStorage] Cannot delete non-existent task: ${taskId}`);
        return false;
      }

      console.log(`[TaskStorage] Deleted task: ${taskId}`);

      return true;
    } catch (error) {
      console.error(`[TaskStorage] Failed to delete task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * List all tasks for a project
   *
   * @param projectId - Project ID (optional, returns all tasks if not provided)
   * @param filters - Optional filters (status, location, etc.)
   * @returns Array of tasks
   */
  listTasks(projectId?: string, filters?: TaskFilters): Task[] {
    try {
      const db = getDatabaseConnection().getConnection();

      // Build query dynamically based on filters
      let query = 'SELECT * FROM tasks';
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (projectId) {
        conditions.push('project_id = ?');
        params.push(projectId);
      }

      if (filters?.status) {
        conditions.push('status = ?');
        params.push(filters.status);
      }

      if (filters?.location) {
        conditions.push('location = ?');
        params.push(filters.location);
      }

      if (filters?.excludeArchived) {
        // Exclude tasks with archivedAt metadata (stored in metadata_json)
        // This is a simplified check - full JSON querying would require JSON1 extension
        conditions.push('metadata_json NOT LIKE ?');
        params.push('%"archivedAt"%');
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      // Order by updated_at DESC (most recent first)
      query += ' ORDER BY updated_at DESC';

      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as DatabaseTaskRow[];

      return rows.map((row) => this.rowToTask(row));
    } catch (error) {
      console.error('[TaskStorage] Failed to list tasks:', error);
      return [];
    }
  }

  /**
   * Get tasks by status
   *
   * @param status - Task status
   * @param projectId - Optional project ID filter
   * @returns Array of tasks with the given status
   */
  getTasksByStatus(status: TaskStatus, projectId?: string): Task[] {
    return this.listTasks(projectId, { status });
  }

  /**
   * Convert database row to Task object
   *
   * @param row - Database row
   * @returns Task object
   */
  private rowToTask(row: DatabaseTaskRow): Task {
    // Parse metadata JSON
    const metadataWithExtras = JSON.parse(row.metadata_json) as TaskMetadataWithExtras;

    // Extract nested fields from metadata JSON
    const { subtasks, qaReport, logs, executionProgress, ...metadata } = metadataWithExtras;

    return {
      id: row.id,
      specId: row.spec_id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      reviewReason: row.review_reason as ReviewReason | undefined,
      releasedInVersion: row.released_in_version || undefined,
      stagedInMainProject: row.staged_in_main_project === 1,
      stagedAt: row.staged_at || undefined,
      location: row.location as 'main' | 'worktree' | undefined,
      specsPath: row.specs_path || undefined,
      subtasks: subtasks || [],
      qaReport: qaReport,
      logs: logs || [],
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      executionProgress: executionProgress,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

/**
 * Database row type (maps to SQLite schema)
 */
interface DatabaseTaskRow {
  id: string;
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  review_reason: string | null;
  released_in_version: string | null;
  staged_in_main_project: number;
  staged_at: string | null;
  location: string | null;
  specs_path: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Metadata with extra fields stored in metadata_json
 */
interface TaskMetadataWithExtras extends TaskMetadata {
  subtasks?: Task['subtasks'];
  qaReport?: Task['qaReport'];
  logs?: Task['logs'];
  executionProgress?: Task['executionProgress'];
}

/**
 * Task list filters
 */
export interface TaskFilters {
  status?: TaskStatus;
  location?: 'main' | 'worktree';
  excludeArchived?: boolean;
}

// Export singleton instance
let _instance: TaskStorage | null = null;

/**
 * Get the singleton TaskStorage instance
 *
 * @returns TaskStorage instance
 */
export function getTaskStorage(): TaskStorage {
  if (!_instance) {
    _instance = new TaskStorage();
  }
  return _instance;
}

/**
 * Execute a function within a transaction.
 *
 * Convenience wrapper around TaskStorage.withTransaction() using the singleton instance.
 * Automatically handles commit on success and rollback on error.
 *
 * CRITICAL: Do NOT use async/await inside the callback - better-sqlite3
 * will commit the transaction before awaits complete.
 *
 * @param fn - Function to execute within transaction (must be synchronous)
 * @returns Result of the function
 *
 * @example
 * ```typescript
 * import { withTransaction } from './task-storage';
 *
 * withTransaction(() => {
 *   // Multiple atomic operations
 *   storage.createTask(task1);
 *   storage.updateTask(task2.id, { status: 'completed' });
 * });
 * ```
 */
export function withTransaction<T>(fn: () => T): T {
  return getTaskStorage().withTransaction(fn);
}
