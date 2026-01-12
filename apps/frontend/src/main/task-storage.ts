/**
 * Task Storage Layer with SQLite CRUD Operations
 * ===============================================
 *
 * Provides database-backed task storage with project-local databases.
 *
 * Key Features:
 * - Create, read, update, delete operations for tasks
 * - Project-local databases: each project has its own SQLite database
 * - Prepared statements for SQL injection prevention
 * - Automatic serialization of TaskMetadata, subtasks, QA reports, etc.
 * - Database triggers automatically emit IPC events for real-time UI updates
 *
 * Usage:
 * ```typescript
 * // For project-specific tasks
 * const storage = getProjectTaskStorage('/path/to/project');
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
import { getProjectDatabaseManager, type DatabaseConnection, type ProjectDatabaseConnection } from './database';

/**
 * Task Storage Service
 * Handles task CRUD operations with project-local SQLite database.
 *
 * Each project has its own database at <project>/.auto-claude/tasks.db
 * This database is shared between the Electron frontend and Python backend.
 */
export class TaskStorage {
  private readonly dbConnection: ProjectDatabaseConnection;
  private readonly projectPath: string;

  /**
   * Create a TaskStorage instance for a project.
   *
   * @param projectPath - Path to the project root directory (REQUIRED)
   * @throws Error if projectPath is not provided
   */
  constructor(projectPath: string) {
    if (!projectPath) {
      throw new Error(
        '[TaskStorage] projectPath is required. Use getProjectTaskStorage(projectPath) to get a TaskStorage instance.'
      );
    }

    this.projectPath = projectPath;
    this.dbConnection = getProjectDatabaseManager().getConnection(projectPath);
    console.log(`[TaskStorage] Using project-local database: ${projectPath}`);
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
    return this.dbConnection.withTransaction(fn);
  }

  /**
   * Get the project path for this storage instance.
   *
   * @returns Project path
   */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Create a new task in the database
   *
   * @param task - Task object to create
   * @returns Created task
   */
  createTask(task: Task): Task {
    try {
      const db = this.dbConnection.getConnection();

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
      const db = this.dbConnection.getConnection();

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
      const db = this.dbConnection.getConnection();

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
      const db = this.dbConnection.getConnection();

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
      const db = this.dbConnection.getConnection();

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
      const db = this.dbConnection.getConnection();

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

// Per-project storage instances
const _projectStorages = new Map<string, TaskStorage>();

/**
 * Get a TaskStorage instance for a specific project.
 *
 * Uses project-local database at <project>/.auto-claude/tasks.db.
 * Caches instances per project path.
 *
 * @param projectPath - Path to the project root directory
 * @returns TaskStorage instance for the project
 */
export function getProjectTaskStorage(projectPath: string): TaskStorage {
  if (!projectPath) {
    throw new Error('[TaskStorage] projectPath is required');
  }
  if (!_projectStorages.has(projectPath)) {
    _projectStorages.set(projectPath, new TaskStorage(projectPath));
  }
  return _projectStorages.get(projectPath)!;
}

/**
 * Get a TaskStorage instance.
 *
 * @deprecated REMOVED - Tasks are now stored in project-local databases.
 *             Use getProjectTaskStorage(projectPath) instead.
 * @throws Error always - use getProjectTaskStorage(projectPath) instead
 */
export function getTaskStorage(): never {
  throw new Error(
    '[TaskStorage] getTaskStorage() is no longer supported. ' +
    'Tasks are now stored in project-local databases. ' +
    'Use getProjectTaskStorage(projectPath) instead.'
  );
}

/**
 * Clear all cached TaskStorage instances.
 * Call this when closing the app or switching contexts.
 */
export function clearTaskStorageCaches(): void {
  _projectStorages.clear();
}

/**
 * Execute a function within a transaction for a project.
 *
 * Convenience wrapper around TaskStorage.withTransaction().
 * Automatically handles commit on success and rollback on error.
 *
 * CRITICAL: Do NOT use async/await inside the callback - better-sqlite3
 * will commit the transaction before awaits complete.
 *
 * @param projectPath - Path to the project root directory
 * @param fn - Function to execute within transaction (must be synchronous)
 * @returns Result of the function
 *
 * @example
 * ```typescript
 * import { withProjectTransaction } from './task-storage';
 *
 * withProjectTransaction('/path/to/project', () => {
 *   // Multiple atomic operations
 *   storage.createTask(task1);
 *   storage.updateTask(task2.id, { status: 'completed' });
 * });
 * ```
 */
export function withProjectTransaction<T>(projectPath: string, fn: () => T): T {
  return getProjectTaskStorage(projectPath).withTransaction(fn);
}

/**
 * @deprecated Use withProjectTransaction(projectPath, fn) instead
 * @throws Error always
 */
export function withTransaction<T>(_fn: () => T): never {
  throw new Error(
    '[TaskStorage] withTransaction() is no longer supported. ' +
    'Use withProjectTransaction(projectPath, fn) instead.'
  );
}
