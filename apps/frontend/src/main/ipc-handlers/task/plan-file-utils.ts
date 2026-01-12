/**
 * Plan/Task Status Utilities
 *
 * Provides operations for updating task status and plan data in SQLite database.
 *
 * NOTE: This module was refactored from JSON file operations to SQLite-only operations.
 * All task data is now stored in the SQLite database, not in JSON files.
 * JSON files are only read during migration to populate the database.
 */

import path from 'path';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { TaskStatus, Project, Task, Subtask, ExecutionProgress } from '../../../shared/types';
import { getTaskStorage } from '../../task-storage';
import { projectStore } from '../../project-store';

/**
 * Get the plan file path for a task (kept for backward compatibility with migration code)
 * @deprecated Use SQLite database instead of plan files
 */
export function getPlanPath(project: Project, task: Task): string {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(project.path, specsBaseDir, task.specId);
  return path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
}

/**
 * Map UI TaskStatus to Python-compatible planStatus
 * @deprecated Python backend should read from SQLite directly
 */
export function mapStatusToPlanStatus(status: TaskStatus): string {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
    case 'human_review':
      return 'review';
    case 'done':
      return 'completed';
    default:
      return 'pending';
  }
}

/**
 * Persist task status to SQLite database.
 *
 * @param _planPath - Ignored (kept for API compatibility during migration)
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache
 * @param taskId - Task ID to update (required for SQLite)
 * @returns true if status was persisted, false otherwise
 */
export async function persistPlanStatus(
  _planPath: string,
  status: TaskStatus,
  projectId?: string,
  taskId?: string
): Promise<boolean> {
  if (!taskId) {
    console.warn('[plan-file-utils] persistPlanStatus called without taskId - cannot update SQLite');
    return false;
  }

  try {
    const storage = getTaskStorage();
    const result = storage.updateTask(taskId, { status });

    if (result) {
      // Invalidate tasks cache since status changed
      if (projectId) {
        projectStore.invalidateTasksCache(projectId);
      }
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist status for task ${taskId}:`, err);
    return false;
  }
}

/**
 * Persist task status synchronously to SQLite database.
 *
 * @param _planPath - Ignored (kept for API compatibility during migration)
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache
 * @param taskId - Task ID to update (required for SQLite)
 * @returns true if status was persisted, false otherwise
 */
export function persistPlanStatusSync(
  _planPath: string,
  status: TaskStatus,
  projectId?: string,
  taskId?: string
): boolean {
  if (!taskId) {
    console.warn('[plan-file-utils] persistPlanStatusSync called without taskId - cannot update SQLite');
    return false;
  }

  try {
    const storage = getTaskStorage();
    const result = storage.updateTask(taskId, { status });

    if (result) {
      // Invalidate tasks cache since status changed
      if (projectId) {
        projectStore.invalidateTasksCache(projectId);
      }
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist status for task ${taskId}:`, err);
    return false;
  }
}

/**
 * Update task data in SQLite database.
 *
 * @param taskId - Task ID to update
 * @param updates - Partial task updates
 * @returns The updated task, or null if not found
 */
export function updateTaskInDatabase(
  taskId: string,
  updates: Partial<{
    status: TaskStatus;
    subtasks: Subtask[];
    executionProgress: ExecutionProgress;
    title: string;
    description: string;
  }>
): Task | null {
  try {
    const storage = getTaskStorage();
    return storage.updateTask(taskId, updates);
  } catch (err) {
    console.warn(`[plan-file-utils] Could not update task ${taskId}:`, err);
    return null;
  }
}

/**
 * Create a new task in SQLite database if it doesn't exist.
 * This replaces the old createPlanIfNotExists function.
 *
 * @param task - The task to create
 * @param status - Initial status for the task
 */
export function createTaskIfNotExists(task: Task, status: TaskStatus): void {
  try {
    const storage = getTaskStorage();

    // Check if task already exists
    const existing = storage.getTask(task.id);
    if (existing) {
      return; // Task exists, nothing to do
    }

    // Create the task with initial status
    storage.createTask({
      ...task,
      status
    });
  } catch (err) {
    console.warn(`[plan-file-utils] Could not create task ${task.id}:`, err);
  }
}

// Legacy exports for backward compatibility during migration
// These are deprecated and will be removed once all callers are updated

/**
 * @deprecated Use updateTaskInDatabase instead
 */
export async function updatePlanFile<T extends Record<string, unknown>>(
  _planPath: string,
  _updater: (plan: T) => T
): Promise<T | null> {
  console.warn('[plan-file-utils] updatePlanFile is deprecated - use updateTaskInDatabase instead');
  return null;
}

/**
 * @deprecated Use createTaskIfNotExists instead
 */
export async function createPlanIfNotExists(
  _planPath: string,
  task: Task,
  status: TaskStatus
): Promise<void> {
  console.warn('[plan-file-utils] createPlanIfNotExists is deprecated - use createTaskIfNotExists instead');
  createTaskIfNotExists(task, status);
}
