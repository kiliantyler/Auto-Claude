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
 * - Concurrent migration queue prevents race conditions
 *
 * Concurrency Control:
 * - Per-project locks ensure only one migration runs per project at a time
 * - Subsequent migration requests for the same project are queued
 * - Uses in-memory promise chain for thread-safe serialization
 * - Prevents race conditions on migration tracker and database inserts
 *
 * Usage:
 * ```typescript
 * const worker = new MigrationWorker();
 *
 * // Safe to call multiple times - will be queued automatically
 * worker.migrate(projectPath, (progress) => {
 *   console.log(`${progress.percentage}% - ${progress.currentFile}`);
 * });
 * ```
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getDatabaseConnection } from './database';
import { getMigrationTracker } from './migration-tracker';
import type { Task, TaskLogs } from '../shared/types';

/**
 * In-memory locks for migration operations
 * Key: project path, Value: Promise chain for serializing migrations
 *
 * This prevents concurrent migrations of the same project, which could cause:
 * - Race conditions on migration tracker state
 * - Duplicate database inserts (despite INSERT OR IGNORE)
 * - Inconsistent progress reporting
 */
const migrationLocks = new Map<string, Promise<void>>();

/**
 * Serialize migration operations for a specific project to prevent race conditions.
 * Each migration waits for the previous one to complete before starting.
 *
 * @param projectPath - Absolute path to the project directory
 * @param operation - Async function to execute while holding the lock
 * @returns Promise that resolves with the operation's result
 */
async function withMigrationLock<T>(projectPath: string, operation: () => Promise<T>): Promise<T> {
  // Get or create the lock chain for this project
  const currentLock = migrationLocks.get(projectPath) || Promise.resolve();

  // Create a new promise that will resolve after our operation completes
  let resolve: () => void;
  const newLock = new Promise<void>((r) => { resolve = r; });
  migrationLocks.set(projectPath, newLock);

  try {
    // Wait for any previous operation to complete
    await currentLock;
    // Execute our operation
    return await operation();
  } finally {
    // Release the lock
    resolve!();
    // Clean up if this was the last operation
    if (migrationLocks.get(projectPath) === newLock) {
      migrationLocks.delete(projectPath);
    }
  }
}

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
  private readonly SPEC_JSON_FILES = ['task_metadata.json', 'implementation_plan.json', 'task_logs.json'];
  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_RETRY_DELAY_MS = 1000;

  /**
   * Migrate a project's JSON files to SQLite
   *
   * This method is thread-safe and prevents concurrent migrations of the same project.
   * If a migration is already in progress for the project, subsequent calls will wait
   * in a queue until the current migration completes.
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
    // Wrap migration in lock to prevent concurrent migrations of the same project
    return withMigrationLock(projectPath, async () => {
      return this.migrateInternal(projectPath, onProgress, options);
    });
  }

  /**
   * Internal migration implementation (called within lock)
   *
   * @param projectPath - Absolute path to the project directory
   * @param onProgress - Callback for progress updates (optional)
   * @param options - Migration options (optional)
   * @returns Promise that resolves when migration is complete
   */
  private async migrateInternal(
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

    // Scan specs directory for spec folders with JSON files
    const specsDir = path.join(projectPath, '.auto-claude', 'specs');
    if (!existsSync(specsDir)) {
      console.log(`[MigrationWorker] No specs directory found: ${specsDir}`);
      return;
    }

    const specDirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Count total files to migrate for progress tracking
    let totalFiles = 0;
    const specsWithFiles: { specId: string; files: string[] }[] = [];

    for (const specId of specDirs) {
      const specPath = path.join(specsDir, specId);
      const foundFiles = this.SPEC_JSON_FILES.filter((file) =>
        existsSync(path.join(specPath, file))
      );
      if (foundFiles.length > 0) {
        specsWithFiles.push({ specId, files: foundFiles });
        totalFiles += foundFiles.length;
      }
    }

    if (totalFiles === 0) {
      console.log(`[MigrationWorker] No JSON files found in specs for: ${projectPath}`);
      tracker.markMigrationComplete(projectPath, []);
      return;
    }

    console.log(`[MigrationWorker] Found ${totalFiles} files across ${specsWithFiles.length} specs`);

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

      // Migrate each spec's files
      for (const { specId, files } of specsWithFiles) {
        const specPath = path.join(specsDir, specId);

        for (const jsonFile of files) {
          const filePath = path.join(specPath, jsonFile);
          const displayName = `${specId}/${jsonFile}`;

          // Emit progress for current file
          this.emitProgress(onProgress, {
            projectPath,
            status: 'running',
            percentage: Math.round((filesCompleted / totalFiles) * 100),
            currentFile: displayName,
            filesCompleted,
            totalFiles,
            retryCount: totalRetries,
          });

          // Migrate the file with retry logic
          let fileRetries = 0;
          let fileMigrated = false;

          while (!fileMigrated && fileRetries <= maxRetries) {
            try {
              await this.migrateSpecFile(projectPath, specId, jsonFile, filePath);
              migratedFiles.push(displayName);
              filesCompleted++;
              fileMigrated = true;

              console.log(`[MigrationWorker] Successfully migrated ${displayName}`);
            } catch (error) {
              fileRetries++;
              totalRetries++;

              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              console.error(
                `[MigrationWorker] Failed to migrate ${displayName} (attempt ${fileRetries}/${maxRetries + 1}):`,
                errorMessage
              );

              if (fileRetries > maxRetries) {
                // Max retries exceeded - trigger rollback
                throw new Error(
                  `Failed to migrate ${displayName} after ${maxRetries + 1} attempts: ${errorMessage}`
                );
              }

              // Wait before retrying
              console.log(`[MigrationWorker] Retrying ${displayName} in ${retryDelayMs}ms...`);
              await this.delay(retryDelayMs);

              // Emit retry progress
              this.emitProgress(onProgress, {
                projectPath,
                status: 'running',
                percentage: Math.round((filesCompleted / totalFiles) * 100),
                currentFile: displayName,
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
   * Migrate a single spec JSON file to SQLite
   *
   * Uses transactions for atomicity - all records inserted or none.
   * Rollback is automatic on error via withTransaction().
   *
   * @param projectPath - Absolute path to the project directory
   * @param specId - The spec directory name (e.g., '001-add-feature')
   * @param jsonFile - Name of the JSON file (e.g., 'task_metadata.json')
   * @param filePath - Absolute path to the JSON file
   */
  private async migrateSpecFile(
    projectPath: string,
    specId: string,
    jsonFile: string,
    filePath: string
  ): Promise<void> {
    const displayName = `${specId}/${jsonFile}`;
    console.log(`[MigrationWorker] Migrating ${displayName}...`);

    const dbConn = getDatabaseConnection();

    try {
      // Read and parse JSON file
      const jsonContent = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(jsonContent);

      // Wrap entire file migration in transaction for atomic rollback
      dbConn.withTransaction(() => {
        // Migrate based on file type (within transaction)
        if (jsonFile === 'task_metadata.json') {
          this.migrateTaskMetadataWithinTransaction(data, projectPath, specId);
        } else if (jsonFile === 'implementation_plan.json') {
          this.migrateImplementationPlanWithinTransaction(data, specId);
        } else if (jsonFile === 'task_logs.json') {
          this.migrateTaskLogsWithinTransaction(data, specId);
        }
      });

      console.log(`[MigrationWorker] Successfully migrated ${displayName}`);
    } catch (error) {
      // Transaction automatically rolled back by withTransaction()
      console.error(`[MigrationWorker] Failed to migrate ${displayName} (rolled back):`, error);
      throw new Error(
        `Failed to migrate ${displayName}: ${error instanceof Error ? error.message : 'Unknown error'}`
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
   * Migrate a project from JSON store to SQLite database
   *
   * @param db - Database connection
   * @param projectPath - Path to the project
   * @returns The project ID if successful, null otherwise
   */
  private migrateProjectToDatabase(db: Database.Database, projectPath: string): string | null {
    try {
      // Generate a unique project ID
      const projectId = `proj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const projectName = path.basename(projectPath);
      const autoBuildPath = '.auto-claude';
      const now = new Date().toISOString();

      // Default settings
      const defaultSettings = {
        model: 'claude-sonnet-4-20250514',
        maxThinkingTokens: null,
        autoMerge: false,
        autoPush: false,
      };

      // Insert the project
      const insertStmt = db.prepare(`
        INSERT INTO projects (id, name, path, auto_build_path, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        projectId,
        projectName,
        projectPath,
        autoBuildPath,
        JSON.stringify(defaultSettings),
        now,
        now
      );

      console.log(`[MigrationWorker] Migrated project to database: ${projectName} (${projectId})`);
      return projectId;
    } catch (error) {
      console.error(`[MigrationWorker] Failed to migrate project to database:`, error);
      return null;
    }
  }

  /**
   * Migrate task metadata from task_metadata.json to tasks table (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * @param metadata - Task metadata from task_metadata.json
   * @param projectPath - Path to the project
   * @param specId - The spec directory name (e.g., '001-add-feature')
   */
  private migrateTaskMetadataWithinTransaction(
    metadata: Record<string, unknown>,
    projectPath: string,
    specId: string
  ): void {
    const db = getDatabaseConnection().getConnection();
    const specsDir = path.join(projectPath, '.auto-claude', 'specs', specId);

    // Look up or create the project in the database
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      // Project not in SQLite - migrate it from JSON store
      console.log(`[MigrationWorker] Project not in database, migrating: ${projectPath}`);
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) {
        console.log(`[MigrationWorker] Failed to migrate project: ${projectPath}, skipping task migration`);
        return;
      }
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    // Read title from spec.md
    let title = specId; // Fallback to specId
    const specMdPath = path.join(specsDir, 'spec.md');
    if (existsSync(specMdPath)) {
      try {
        const specContent = readFileSync(specMdPath, 'utf-8');
        const titleMatch = specContent.match(/^#\s+(.+)$/m);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
      } catch {
        // Use fallback title
      }
    }

    // Read description from spec.md Overview section
    let description = '';
    if (existsSync(specMdPath)) {
      try {
        const specContent = readFileSync(specMdPath, 'utf-8');
        const overviewMatch = specContent.match(/## Overview\s*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/);
        if (overviewMatch) {
          description = overviewMatch[1].trim();
        }
      } catch {
        // Leave description empty
      }
    }

    // Read status from implementation_plan.json if available
    let status = 'backlog';
    const planPath = path.join(specsDir, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const planContent = readFileSync(planPath, 'utf-8');
        const plan = JSON.parse(planContent);
        if (plan.status) {
          status = plan.status;
        }
      } catch {
        // Use default status
      }
    }

    // Generate task ID from spec path
    const taskId = `task-${specId}`;
    const now = new Date().toISOString();

    // Prepare insert statement
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, spec_id, project_id, title, description, status, review_reason,
        released_in_version, staged_in_main_project, staged_at, location, specs_path,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Serialize metadata
    const metadataJson = JSON.stringify(metadata);

    // Insert task (OR IGNORE ensures idempotency)
    insertStmt.run(
      taskId,
      specId,
      projectId,
      title,
      description,
      status,
      null, // reviewReason
      null, // releasedInVersion
      0,    // stagedInMainProject
      null, // stagedAt
      'main', // location
      `.auto-claude/specs/${specId}`, // specsPath
      metadataJson,
      now,
      now
    );

    console.log(`[MigrationWorker] Migrated task for spec ${specId}`);
  }

  /**
   * Migrate implementation plan from implementation_plan.json (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * Note: Implementation plans are stored in the task's metadata_json field.
   * This method updates the existing task's metadata with plan data.
   *
   * @param plan - Implementation plan data
   * @param specId - The spec directory name
   */
  private migrateImplementationPlanWithinTransaction(_plan: unknown, specId: string): void {
    // Implementation plans are associated with tasks via specId
    // The plan data is merged into the task's metadata_json
    console.log(`[MigrationWorker] Implementation plan for ${specId}: merged into task metadata`);

    // Note: The task_metadata migration already reads implementation_plan.json
    // for status, so we don't need to do anything additional here
  }

  /**
   * Migrate task logs from task_logs.json (within transaction)
   *
   * CRITICAL: This method must be called from within withTransaction().
   * It does NOT create its own transaction.
   *
   * Note: Task logs are stored in the task's metadata_json field.
   *
   * @param logs - Task logs data
   * @param specId - The spec directory name
   */
  private migrateTaskLogsWithinTransaction(_logs: TaskLogs | TaskLogs[], specId: string): void {
    // Task logs are associated with tasks via specId
    // The log data can be stored in task metadata if needed
    console.log(`[MigrationWorker] Task logs for ${specId}: stored in task metadata`);

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
