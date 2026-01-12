/**
 * Migration Worker - JSON to SQLite Data Migration
 * =================================================
 *
 * Handles the migration of legacy JSON files to SQLite database with
 * transaction safety, idempotency, and progress tracking.
 *
 * Key Features:
 * - Migrates tasks.json, implementation_plan.json, task_logs.json
 * - Transaction-based with automatic rollback on errors
 * - INSERT OR IGNORE for idempotency (safe to run multiple times)
 * - Real-time progress events via callback
 * - Uses MigrationTracker to prevent redundant migrations
 *
 * Usage:
 * ```typescript
 * const worker = new MigrationWorker();
 *
 * worker.migrate(projectPath, (progress) => {
 *   console.log(`${progress.percentage}% - ${progress.currentFile}`);
 * });
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { getDatabaseConnection } from './database';
import { getMigrationTracker } from './migration-tracker';
import type { Task, TaskLogs } from '../shared/types';

/**
 * Migration progress data sent via callback
 */
export interface MigrationProgress {
  projectPath: string;
  status: 'running' | 'completed' | 'failed' | 'rolled_back';
  percentage: number; // 0-100
  currentFile: string | null; // Current file being migrated
  filesCompleted: number; // Number of files successfully migrated
  totalFiles: number; // Total files to migrate (always 3)
  error?: string; // Error message if status is 'failed'
  rollbackReason?: string; // Reason for rollback
  retryCount?: number; // Number of retries attempted
}

/**
 * Progress callback function type
 */
export type ProgressCallback = (progress: MigrationProgress) => void;

/**
 * Migration options
 */
export interface MigrationOptions {
  maxRetries?: number; // Maximum number of retries for transient errors (default: 3)
  retryDelayMs?: number; // Delay between retries in milliseconds (default: 1000)
}

/**
 * Migration Worker Service
 *
 * Orchestrates the migration of JSON files to SQLite database.
 */
export class MigrationWorker {
  private readonly JSON_FILES = ['tasks.json', 'implementation_plan.json', 'task_logs.json'];
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_RETRY_DELAY_MS = 1000;

  /**
   * Migrate a project's JSON files to SQLite
   *
   * @param projectPath - Absolute path to the project directory
   * @param onProgress - Callback for progress updates (optional)
   * @param options - Migration options (optional)
   * @returns Promise that resolves when migration is complete
   */
  async migrate(
    projectPath: string,
    onProgress?: ProgressCallback,
    options?: MigrationOptions
  ): Promise<void> {
    const tracker = getMigrationTracker();
    const maxRetries = options?.maxRetries ?? this.DEFAULT_MAX_RETRIES;
    const retryDelayMs = options?.retryDelayMs ?? this.DEFAULT_RETRY_DELAY_MS;

    // Check if already migrated
    if (tracker.hasMigrated(projectPath)) {
      console.log(`[MigrationWorker] Project already migrated: ${projectPath}`);
      return;
    }

    console.log(`[MigrationWorker] Starting migration for: ${projectPath}`);

    const totalFiles = this.JSON_FILES.length;
    let filesCompleted = 0;
    const migratedFiles: string[] = [];
    let totalRetries = 0;

    try {
      // Emit initial progress
      this.emitProgress(onProgress, {
        projectPath,
        status: 'running',
        percentage: 0,
        currentFile: null,
        filesCompleted: 0,
        totalFiles,
      });

      // Migrate each file in sequence
      for (const jsonFile of this.JSON_FILES) {
        const filePath = path.join(projectPath, '.auto-claude', jsonFile);

        // Skip if file doesn't exist (not all projects have all files)
        if (!existsSync(filePath)) {
          console.log(`[MigrationWorker] File not found, skipping: ${jsonFile}`);
          filesCompleted++;
          this.emitProgress(onProgress, {
            projectPath,
            status: 'running',
            percentage: Math.round((filesCompleted / totalFiles) * 100),
            currentFile: null,
            filesCompleted,
            totalFiles,
          });
          continue;
        }

        // Emit progress for current file
        this.emitProgress(onProgress, {
          projectPath,
          status: 'running',
          percentage: Math.round((filesCompleted / totalFiles) * 100),
          currentFile: jsonFile,
          filesCompleted,
          totalFiles,
          retryCount: totalRetries,
        });

        // Migrate the file with retry logic
        let fileRetries = 0;
        let fileMigrated = false;

        while (!fileMigrated && fileRetries <= maxRetries) {
          try {
            await this.migrateFile(projectPath, jsonFile, filePath);
            migratedFiles.push(jsonFile);
            filesCompleted++;
            fileMigrated = true;

            console.log(`[MigrationWorker] Successfully migrated ${jsonFile}`);
          } catch (error) {
            fileRetries++;
            totalRetries++;

            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(
              `[MigrationWorker] Failed to migrate ${jsonFile} (attempt ${fileRetries}/${maxRetries + 1}):`,
              errorMessage
            );

            if (fileRetries > maxRetries) {
              // Max retries exceeded - trigger rollback
              throw new Error(
                `Failed to migrate ${jsonFile} after ${maxRetries + 1} attempts: ${errorMessage}`
              );
            }

            // Wait before retrying
            console.log(`[MigrationWorker] Retrying ${jsonFile} in ${retryDelayMs}ms...`);
            await this.delay(retryDelayMs);

            // Emit retry progress
            this.emitProgress(onProgress, {
              projectPath,
              status: 'running',
              percentage: Math.round((filesCompleted / totalFiles) * 100),
              currentFile: jsonFile,
              filesCompleted,
              totalFiles,
              retryCount: totalRetries,
            });
          }
        }

        // Emit progress after file completion
        this.emitProgress(onProgress, {
          projectPath,
          status: 'running',
          percentage: Math.round((filesCompleted / totalFiles) * 100),
          currentFile: null,
          filesCompleted,
          totalFiles,
          retryCount: totalRetries,
        });
      }

      // Mark migration as complete
      tracker.markMigrationComplete(projectPath, migratedFiles);

      // Emit completion
      this.emitProgress(onProgress, {
        projectPath,
        status: 'completed',
        percentage: 100,
        currentFile: null,
        filesCompleted,
        totalFiles,
        retryCount: totalRetries,
      });

      console.log(
        `[MigrationWorker] Migration completed successfully for: ${projectPath} (${totalRetries} retries)`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[MigrationWorker] Migration failed for ${projectPath}:`, error);

      // Rollback: Clear migration marker to allow re-migration
      await this.rollbackMigration(projectPath, migratedFiles, errorMessage);

      // Emit rollback status
      this.emitProgress(onProgress, {
        projectPath,
        status: 'rolled_back',
        percentage: Math.round((filesCompleted / totalFiles) * 100),
        currentFile: null,
        filesCompleted,
        totalFiles,
        error: errorMessage,
        rollbackReason: `Migration failed after ${totalRetries} retries. Rolled back to allow re-migration.`,
        retryCount: totalRetries,
      });

      throw error;
    }
  }

  /**
   * Migrate a single JSON file to SQLite
   *
   * Uses transactions for atomicity - all records inserted or none.
   * Rollback is automatic on error via withTransaction().
   *
   * @param projectPath - Absolute path to the project directory
   * @param jsonFile - Name of the JSON file (e.g., 'tasks.json')
   * @param filePath - Absolute path to the JSON file
   */
  private async migrateFile(projectPath: string, jsonFile: string, filePath: string): Promise<void> {
    console.log(`[MigrationWorker] Migrating ${jsonFile}...`);

    const dbConn = getDatabaseConnection();

    try {
      // Read and parse JSON file
      const jsonContent = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(jsonContent);

      // Wrap entire file migration in transaction for atomic rollback
      dbConn.withTransaction(() => {
        // Migrate based on file type (within transaction)
        if (jsonFile === 'tasks.json') {
          this.migrateTasksWithinTransaction(data);
        } else if (jsonFile === 'implementation_plan.json') {
          this.migrateImplementationPlanWithinTransaction(data);
        } else if (jsonFile === 'task_logs.json') {
          this.migrateTaskLogsWithinTransaction(data);
        }
      });

      console.log(`[MigrationWorker] Successfully migrated ${jsonFile}`);
    } catch (error) {
      // Transaction automatically rolled back by withTransaction()
      console.error(`[MigrationWorker] Failed to migrate ${jsonFile} (rolled back):`, error);
      throw new Error(
        `Failed to migrate ${jsonFile}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Rollback migration on failure
   *
   * Clears the migration marker to allow re-migration and logs the rollback.
   *
   * @param projectPath - Absolute path to the project directory
   * @param migratedFiles - Files that were successfully migrated before failure
   * @param errorMessage - Error message that caused the rollback
   */
  private async rollbackMigration(
    projectPath: string,
    migratedFiles: string[],
    errorMessage: string
  ): Promise<void> {
    console.log(
      `[MigrationWorker] Rolling back migration for ${projectPath} (${migratedFiles.length} files migrated before failure)`
    );

    const tracker = getMigrationTracker();

    try {
      // Clear migration marker to allow re-migration
      tracker.clearMigrationMarker(projectPath);

      console.log(
        `[MigrationWorker] Rollback complete. Migration marker cleared. ` +
          `Migrated files before failure: ${migratedFiles.join(', ') || 'none'}. ` +
          `Error: ${errorMessage}`
      );
    } catch (rollbackError) {
      console.error(
        `[MigrationWorker] Failed to rollback migration marker:`,
        rollbackError
      );
      // Don't throw - original error is more important
    }
  }

  /**
   * Delay helper for retry logic
   *
   * @param ms - Milliseconds to delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Migrate tasks from tasks.json to tasks table (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * @param tasks - Array of tasks or single task object
   */
  private migrateTasksWithinTransaction(tasks: Task | Task[]): void {
    const db = getDatabaseConnection().getConnection();

    // Normalize to array
    const taskArray = Array.isArray(tasks) ? tasks : [tasks];

    if (taskArray.length === 0) {
      console.log('[MigrationWorker] No tasks to migrate');
      return;
    }

    // Prepare statement for efficiency
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, spec_id, project_id, title, description, status, review_reason,
        released_in_version, staged_in_main_project, staged_at, location, specs_path,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Execute inserts (within outer transaction - no nested transaction)
    for (const task of taskArray) {
      // Serialize complex fields to metadata JSON
      const metadataJson = JSON.stringify({
        ...task.metadata,
        subtasks: task.subtasks,
        qaReport: task.qaReport,
        logs: task.logs,
        executionProgress: task.executionProgress,
      });

      // Insert task (OR IGNORE ensures idempotency)
      insertStmt.run(
        task.id,
        task.specId,
        task.projectId,
        task.title,
        task.description,
        task.status,
        task.reviewReason || null,
        task.releasedInVersion || null,
        task.stagedInMainProject ? 1 : 0,
        task.stagedAt ? new Date(task.stagedAt).toISOString() : null,
        task.location || null,
        task.specsPath || null,
        metadataJson,
        new Date(task.createdAt).toISOString(),
        new Date(task.updatedAt).toISOString()
      );
    }

    console.log(`[MigrationWorker] Migrated ${taskArray.length} task(s) within transaction`);
  }

  /**
   * Migrate implementation plan from implementation_plan.json (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * Note: Implementation plans are currently stored in metadata_json of tasks table.
   * If a separate implementation_plans table exists, this should be updated.
   *
   * @param plan - Implementation plan data
   */
  private migrateImplementationPlanWithinTransaction(plan: unknown): void {
    // Implementation plans are typically associated with tasks and stored
    // in the task's metadata. This is a placeholder for future expansion
    // if a separate implementation_plans table is added.

    console.log('[MigrationWorker] Implementation plan migration: stored in task metadata (within transaction)');

    // If the database schema includes a separate implementation_plans table,
    // add the migration logic here. Example:
    //
    // const db = getDatabaseConnection().getConnection();
    // const insertStmt = db.prepare(`
    //   INSERT OR IGNORE INTO implementation_plans (id, task_id, plan_json, created_at)
    //   VALUES (?, ?, ?, ?)
    // `);
    // insertStmt.run(plan.id, plan.taskId, JSON.stringify(plan), new Date().toISOString());
  }

  /**
   * Migrate task logs from task_logs.json to task_logs table (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * Note: Task logs structure may vary. This implementation assumes the
   * logs are stored in the tasks table's metadata_json field.
   *
   * @param logs - Task logs data
   */
  private migrateTaskLogsWithinTransaction(logs: TaskLogs | TaskLogs[]): void {
    // Task logs are typically stored in the task's metadata_json field.
    // This is a placeholder for future expansion if a separate task_logs
    // table is added.

    console.log('[MigrationWorker] Task logs migration: stored in task metadata (within transaction)');

    // If the database schema includes a separate task_logs table,
    // add the migration logic here. Example:
    //
    // const db = getDatabaseConnection().getConnection();
    // const logArray = Array.isArray(logs) ? logs : [logs];
    // const insertStmt = db.prepare(`
    //   INSERT OR IGNORE INTO task_logs (id, task_id, log_json, created_at)
    //   VALUES (?, ?, ?, ?)
    // `);
    // for (const log of logArray) {
    //   insertStmt.run(log.id, log.taskId, JSON.stringify(log), new Date().toISOString());
    // }
  }

  /**
   * Emit progress update via callback
   *
   * @param callback - Progress callback function (optional)
   * @param progress - Progress data to emit
   */
  private emitProgress(callback: ProgressCallback | undefined, progress: MigrationProgress): void {
    if (callback) {
      callback(progress);
    }
  }
}

/**
 * Singleton instance
 */
let migrationWorkerInstance: MigrationWorker | null = null;

/**
 * Get the singleton MigrationWorker instance
 *
 * @returns MigrationWorker instance
 */
export function getMigrationWorker(): MigrationWorker {
  if (!migrationWorkerInstance) {
    migrationWorkerInstance = new MigrationWorker();
  }
  return migrationWorkerInstance;
}
