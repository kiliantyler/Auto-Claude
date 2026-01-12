/**
 * Migration Worker - JSON to SQLite Data Migration
 * =================================================
 *
 * Handles the migration of legacy JSON files to SQLite database with
 * transaction safety, idempotency, and progress tracking.
 *
 * Key Features:
 * - Migrates ALL JSON files: tasks, project_index, roadmap, ideation, file_evolution, file-timelines, insights
 * - Transaction-based with automatic rollback on errors
 * - INSERT OR IGNORE for idempotency (safe to run multiple times)
 * - Real-time progress events via callback
 * - Uses MigrationTracker to prevent redundant migrations
 * - Concurrent migration queue prevents race conditions
 * - Per-data-type migration tracking (can migrate different types independently)
 *
 * Concurrency Control:
 * - Per-project locks ensure only one migration runs per project at a time
 * - Subsequent migration requests for the same project are queued
 * - Uses in-memory promise chain for thread-safe serialization
 * - Prevents race conditions on migration tracker and database inserts
 *
 * Data Types Migrated:
 * - tasks: task_metadata.json, implementation_plan.json, task_logs.json (per spec)
 * - project_index: project_index.json (project root)
 * - roadmap: roadmap/*.json (roadmap.json, roadmap_discovery.json)
 * - ideation: ideation/*.json (all ideation files)
 * - file_evolution: file_evolution.json (project root)
 * - file_timelines: file-timelines/*.json (all timeline files)
 * - insights: insights/sessions/*.json (all session files)
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

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getDatabaseConnection } from './database';
import { getMigrationTracker } from './migration-tracker';
import type { Task, TaskLogs } from '../shared/types';

/**
 * Data types that can be migrated
 */
export type MigrationDataType = 'tasks' | 'project_index' | 'roadmap' | 'ideation' | 'file_evolution' | 'file_timelines' | 'insights';

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
  // Spec-level JSON files (per spec directory)
  private readonly SPEC_JSON_FILES = ['task_metadata.json', 'implementation_plan.json', 'task_logs.json'];

  // Project-level JSON files (in .auto-claude root)
  private readonly PROJECT_JSON_FILES = ['project_index.json', 'file_evolution.json'];

  // Directory-based JSON files (all *.json in these directories)
  private readonly JSON_DIRECTORIES = ['roadmap', 'ideation', 'file-timelines', 'insights/sessions'];

  private readonly DEFAULT_MAX_RETRIES = 3;
  private readonly DEFAULT_RETRY_DELAY_MS = 1000;

  // All migration data types
  private readonly ALL_DATA_TYPES: MigrationDataType[] = [
    'tasks', 'project_index', 'roadmap', 'ideation', 'file_evolution', 'file_timelines', 'insights'
  ];

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

    const autoclaudeDir = path.join(projectPath, '.auto-claude');
    if (!existsSync(autoclaudeDir)) {
      console.log(`[MigrationWorker] No .auto-claude directory found: ${autoclaudeDir}`);
      return;
    }

    console.log(`[MigrationWorker] Starting full migration for: ${projectPath}`);

    // Collect all files to migrate across all data types
    const migrationPlan = this.buildMigrationPlan(projectPath);
    const totalFiles = migrationPlan.reduce((sum, item) => sum + item.files.length, 0);

    if (totalFiles === 0) {
      console.log(`[MigrationWorker] No JSON files found for: ${projectPath}`);
      // Mark all data types as migrated (nothing to migrate)
      for (const dataType of this.ALL_DATA_TYPES) {
        this.markDataTypeMigrated(projectPath, dataType, []);
      }
      tracker.markMigrationComplete(projectPath, []);
      return;
    }

    console.log(`[MigrationWorker] Found ${totalFiles} files across ${migrationPlan.length} data types`);

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

      // Migrate each data type
      for (const { dataType, files, backupDir } of migrationPlan) {
        // Skip if this data type was already migrated
        if (this.isDataTypeMigrated(projectPath, dataType)) {
          console.log(`[MigrationWorker] Data type already migrated: ${dataType}`);
          filesCompleted += files.length;
          continue;
        }

        console.log(`[MigrationWorker] Migrating ${dataType}: ${files.length} files`);

        const migratedForType: string[] = [];

        for (const { filePath, displayName } of files) {
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
              await this.migrateFile(projectPath, dataType, filePath, displayName);
              migratedFiles.push(displayName);
              migratedForType.push(filePath);
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

        // Mark data type as migrated and backup files
        this.markDataTypeMigrated(projectPath, dataType, migratedForType);

        // Backup migrated JSON files for this data type
        if (dataType === 'tasks' && migratedForType.length > 0) {
          // For tasks, backup per-spec using the original method
          console.log(`[MigrationWorker] Backing up task JSON files per spec`);
          this.backupSpecJsonFiles(projectPath, migratedForType);
        } else if (backupDir && migratedForType.length > 0) {
          console.log(`[MigrationWorker] Backing up ${dataType} JSON files`);
          this.backupFilesToDir(migratedForType, backupDir);
        }
      }

      // Mark overall migration as complete
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
   * Build a migration plan for all data types
   *
   * @param projectPath - Absolute path to the project directory
   * @returns Array of migration items with files to migrate
   */
  private buildMigrationPlan(projectPath: string): Array<{
    dataType: MigrationDataType;
    files: Array<{ filePath: string; displayName: string }>;
    backupDir: string | null;
  }> {
    const autoclaudeDir = path.join(projectPath, '.auto-claude');
    const plan: Array<{
      dataType: MigrationDataType;
      files: Array<{ filePath: string; displayName: string }>;
      backupDir: string | null;
    }> = [];

    // 1. Tasks (per spec directory)
    const specsDir = path.join(autoclaudeDir, 'specs');
    if (existsSync(specsDir)) {
      const specFiles: Array<{ filePath: string; displayName: string }> = [];
      const specDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '.migrated-backup')
        .map((d) => d.name);

      for (const specId of specDirs) {
        const specPath = path.join(specsDir, specId);
        for (const jsonFile of this.SPEC_JSON_FILES) {
          const filePath = path.join(specPath, jsonFile);
          if (existsSync(filePath)) {
            specFiles.push({
              filePath,
              displayName: `specs/${specId}/${jsonFile}`,
            });
          }
        }
      }

      if (specFiles.length > 0) {
        plan.push({
          dataType: 'tasks',
          files: specFiles,
          backupDir: null, // Handled per-spec in backupJsonFiles
        });
      }
    }

    // 2. Project Index
    const projectIndexPath = path.join(autoclaudeDir, 'project_index.json');
    if (existsSync(projectIndexPath)) {
      plan.push({
        dataType: 'project_index',
        files: [{ filePath: projectIndexPath, displayName: 'project_index.json' }],
        backupDir: path.join(autoclaudeDir, '.migrated-backup'),
      });
    }

    // 3. Roadmap directory
    const roadmapDir = path.join(autoclaudeDir, 'roadmap');
    if (existsSync(roadmapDir)) {
      const roadmapFiles = this.getJsonFilesInDir(roadmapDir, 'roadmap');
      if (roadmapFiles.length > 0) {
        plan.push({
          dataType: 'roadmap',
          files: roadmapFiles,
          backupDir: path.join(roadmapDir, '.migrated-backup'),
        });
      }
    }

    // 4. Ideation directory
    const ideationDir = path.join(autoclaudeDir, 'ideation');
    if (existsSync(ideationDir)) {
      const ideationFiles = this.getJsonFilesInDir(ideationDir, 'ideation');
      if (ideationFiles.length > 0) {
        plan.push({
          dataType: 'ideation',
          files: ideationFiles,
          backupDir: path.join(ideationDir, '.migrated-backup'),
        });
      }
    }

    // 5. File Evolution
    const fileEvolutionPath = path.join(autoclaudeDir, 'file_evolution.json');
    if (existsSync(fileEvolutionPath)) {
      plan.push({
        dataType: 'file_evolution',
        files: [{ filePath: fileEvolutionPath, displayName: 'file_evolution.json' }],
        backupDir: path.join(autoclaudeDir, '.migrated-backup'),
      });
    }

    // 6. File Timelines directory
    const fileTimelinesDir = path.join(autoclaudeDir, 'file-timelines');
    if (existsSync(fileTimelinesDir)) {
      const timelineFiles = this.getJsonFilesInDir(fileTimelinesDir, 'file-timelines');
      if (timelineFiles.length > 0) {
        plan.push({
          dataType: 'file_timelines',
          files: timelineFiles,
          backupDir: path.join(fileTimelinesDir, '.migrated-backup'),
        });
      }
    }

    // 7. Insights/Sessions directory
    const insightsSessionsDir = path.join(autoclaudeDir, 'insights', 'sessions');
    if (existsSync(insightsSessionsDir)) {
      const insightFiles = this.getJsonFilesInDir(insightsSessionsDir, 'insights/sessions');
      if (insightFiles.length > 0) {
        plan.push({
          dataType: 'insights',
          files: insightFiles,
          backupDir: path.join(insightsSessionsDir, '.migrated-backup'),
        });
      }
    }

    return plan;
  }

  /**
   * Get all JSON files in a directory
   *
   * @param dirPath - Directory path
   * @param displayPrefix - Prefix for display names
   * @returns Array of file paths and display names
   */
  private getJsonFilesInDir(dirPath: string, displayPrefix: string): Array<{ filePath: string; displayName: string }> {
    try {
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.json') && f.name !== 'index.json')
        .map((f) => ({
          filePath: path.join(dirPath, f.name),
          displayName: `${displayPrefix}/${f.name}`,
        }));
      return files;
    } catch (error) {
      console.error(`[MigrationWorker] Error reading directory ${dirPath}:`, error);
      return [];
    }
  }

  /**
   * Migrate a single file based on its data type
   *
   * @param projectPath - Project path
   * @param dataType - Type of data being migrated
   * @param filePath - Full path to the JSON file
   * @param displayName - Display name for logging
   */
  private async migrateFile(
    projectPath: string,
    dataType: MigrationDataType,
    filePath: string,
    displayName: string
  ): Promise<void> {
    console.log(`[MigrationWorker] Migrating ${displayName} (${dataType})...`);

    const dbConn = getDatabaseConnection();

    try {
      const jsonContent = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(jsonContent);

      dbConn.withTransaction(() => {
        switch (dataType) {
          case 'tasks':
            // Handle spec files based on filename
            const fileName = path.basename(filePath);
            const specId = path.basename(path.dirname(filePath));
            if (fileName === 'task_metadata.json') {
              this.migrateTaskMetadataWithinTransaction(data, projectPath, specId);
            } else if (fileName === 'implementation_plan.json') {
              this.migrateImplementationPlanWithinTransaction(data, specId);
            } else if (fileName === 'task_logs.json') {
              this.migrateTaskLogsWithinTransaction(data, specId);
            }
            break;
          case 'project_index':
            this.migrateProjectIndexWithinTransaction(data, projectPath);
            break;
          case 'roadmap':
            const roadmapFileName = path.basename(filePath);
            if (roadmapFileName === 'roadmap.json') {
              this.migrateRoadmapWithinTransaction(data, projectPath);
            } else if (roadmapFileName === 'roadmap_discovery.json') {
              this.migrateRoadmapDiscoveryWithinTransaction(data, projectPath);
            }
            break;
          case 'ideation':
            this.migrateIdeationWithinTransaction(data, projectPath, path.basename(filePath));
            break;
          case 'file_evolution':
            this.migrateFileEvolutionWithinTransaction(data, projectPath);
            break;
          case 'file_timelines':
            this.migrateFileTimelineWithinTransaction(data, projectPath);
            break;
          case 'insights':
            this.migrateInsightSessionWithinTransaction(data, projectPath);
            break;
        }
      });

      console.log(`[MigrationWorker] Successfully migrated ${displayName}`);
    } catch (error) {
      console.error(`[MigrationWorker] Failed to migrate ${displayName}:`, error);
      throw new Error(
        `Failed to migrate ${displayName}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if a data type has already been migrated for a project
   *
   * @param projectPath - Project path
   * @param dataType - Data type to check
   * @returns True if already migrated
   */
  private isDataTypeMigrated(projectPath: string, dataType: MigrationDataType): boolean {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare('SELECT 1 FROM migration_status WHERE project_path = ? AND data_type = ?');
      const row = stmt.get(projectPath, dataType);
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Mark a data type as migrated
   *
   * @param projectPath - Project path
   * @param dataType - Data type that was migrated
   * @param files - List of files that were migrated
   */
  private markDataTypeMigrated(projectPath: string, dataType: MigrationDataType, files: string[]): void {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO migration_status (project_path, data_type, migrated_at, version, files_migrated_json)
        VALUES (?, ?, datetime('now'), '1.0', ?)
      `);
      stmt.run(projectPath, dataType, JSON.stringify(files));
      console.log(`[MigrationWorker] Marked ${dataType} as migrated for ${projectPath}`);
    } catch (error) {
      console.error(`[MigrationWorker] Failed to mark migration status:`, error);
    }
  }

  /**
   * Backup files to a specified directory
   *
   * @param files - Array of file paths to backup
   * @param backupDir - Directory to move files to
   */
  private backupFilesToDir(files: string[], backupDir: string): void {
    try {
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }

      for (const filePath of files) {
        if (existsSync(filePath)) {
          const fileName = path.basename(filePath);
          const destPath = path.join(backupDir, fileName);
          renameSync(filePath, destPath);
          console.log(`[MigrationWorker] Backed up: ${fileName}`);
        }
      }
    } catch (error) {
      console.error(`[MigrationWorker] Failed to backup files:`, error);
    }
  }

  /**
   * Backup spec JSON files grouped by spec directory
   *
   * @param projectPath - Project path
   * @param filePaths - Array of full file paths to backup
   */
  private backupSpecJsonFiles(projectPath: string, filePaths: string[]): void {
    // Group files by spec ID
    const specFiles = new Map<string, string[]>();

    for (const filePath of filePaths) {
      // Extract spec ID from path: .../specs/<specId>/<file>.json
      const specId = path.basename(path.dirname(filePath));
      const fileName = path.basename(filePath);

      if (!specFiles.has(specId)) {
        specFiles.set(specId, []);
      }
      specFiles.get(specId)!.push(fileName);
    }

    // Backup each spec's files
    for (const [specId, files] of specFiles) {
      this.backupJsonFiles(projectPath, specId, files);
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
   * Backup JSON files by moving them to a .migrated-backup directory
   *
   * @param projectPath - Path to the project
   * @param specId - The spec directory name
   * @param files - List of JSON files to backup
   */
  private backupJsonFiles(projectPath: string, specId: string, files: string[]): void {
    const specsDir = path.join(projectPath, '.auto-claude', 'specs', specId);
    const backupDir = path.join(specsDir, '.migrated-backup');

    try {
      // Create backup directory if it doesn't exist
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }

      // Move each JSON file to backup
      for (const file of files) {
        const sourcePath = path.join(specsDir, file);
        const destPath = path.join(backupDir, file);

        if (existsSync(sourcePath)) {
          renameSync(sourcePath, destPath);
          console.log(`[MigrationWorker] Backed up: ${specId}/${file}`);
        }
      }
    } catch (error) {
      console.error(`[MigrationWorker] Failed to backup files for ${specId}:`, error);
      // Don't throw - backup failure shouldn't stop the migration
    }
  }

  /**
   * Backup any remaining JSON files for already-migrated projects
   * Called on startup to clean up files from previous migrations
   *
   * @param projectPath - Path to the project
   */
  public backupRemainingJsonFiles(projectPath: string): void {
    const autoclaudeDir = path.join(projectPath, '.auto-claude');
    if (!existsSync(autoclaudeDir)) return;

    try {
      // 1. Backup spec JSON files
      const specsDir = path.join(autoclaudeDir, 'specs');
      if (existsSync(specsDir)) {
        const specDirs = readdirSync(specsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== '.migrated-backup')
          .map((d) => d.name);

        for (const specId of specDirs) {
          const specPath = path.join(specsDir, specId);
          const foundFiles = this.SPEC_JSON_FILES.filter((file) =>
            existsSync(path.join(specPath, file))
          );

          if (foundFiles.length > 0) {
            this.backupJsonFiles(projectPath, specId, foundFiles);
          }
        }
      }

      // 2. Backup project-level JSON files
      const projectBackupDir = path.join(autoclaudeDir, '.migrated-backup');
      for (const jsonFile of this.PROJECT_JSON_FILES) {
        const filePath = path.join(autoclaudeDir, jsonFile);
        if (existsSync(filePath)) {
          this.backupFilesToDir([filePath], projectBackupDir);
        }
      }

      // 3. Backup directory-based JSON files
      for (const dirName of this.JSON_DIRECTORIES) {
        const dirPath = path.join(autoclaudeDir, dirName);
        if (existsSync(dirPath)) {
          const jsonFiles = this.getJsonFilesInDir(dirPath, dirName);
          if (jsonFiles.length > 0) {
            const backupDir = path.join(dirPath, '.migrated-backup');
            this.backupFilesToDir(jsonFiles.map((f) => f.filePath), backupDir);
          }
        }
      }
    } catch (error) {
      console.error(`[MigrationWorker] Error backing up remaining JSON files:`, error);
    }
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

    // Read status and subtasks from implementation_plan.json if available
    let status = 'backlog';
    let subtasks: Array<{
      id: string;
      title: string;
      description: string;
      status: string;
      files: string[];
      verification?: unknown;
    }> = [];

    const planPath = path.join(specsDir, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const planContent = readFileSync(planPath, 'utf-8');
        const plan = JSON.parse(planContent);
        if (plan.status) {
          // Normalize legacy status values to valid TaskStatus
          status = this.normalizeTaskStatus(plan.status);
        }

        // Extract subtasks from phases array
        if (plan.phases && Array.isArray(plan.phases)) {
          subtasks = plan.phases.flatMap((phase: Record<string, unknown>) => {
            const phaseSubtasks = phase.subtasks as Array<Record<string, unknown>> | undefined;
            if (!phaseSubtasks || !Array.isArray(phaseSubtasks)) {
              return [];
            }
            return phaseSubtasks.map((subtask) => ({
              id: (subtask.id as string) || `subtask-${Math.random().toString(36).substr(2, 9)}`,
              title: (subtask.description as string) || '',
              description: (subtask.description as string) || '',
              status: this.normalizeSubtaskStatus((subtask.status as string) || 'pending'),
              files: [],
              verification: subtask.verification
            }));
          });
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

    // Serialize metadata with subtasks and other fields
    // This matches the format expected by TaskStorage.rowToTask()
    const metadataJson = JSON.stringify({
      ...metadata,
      subtasks,
      qaReport: undefined,
      logs: [],
      executionProgress: undefined
    });

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

  // ============================================
  // Status Normalization
  // ============================================

  /**
   * Normalize legacy status values to valid TaskStatus
   *
   * Valid TaskStatus values: 'backlog' | 'in_progress' | 'ai_review' | 'human_review' | 'done'
   *
   * Legacy values that need mapping:
   * - 'pending' → 'backlog'
   * - 'planning' → 'backlog'
   * - 'planned' → 'backlog'
   * - 'completed' → 'done'
   * - 'approved' → 'done'
   * - 'finished' → 'done'
   * - 'running' → 'in_progress'
   * - 'active' → 'in_progress'
   * - 'review' → 'human_review'
   * - 'qa' → 'ai_review'
   * - 'qa_review' → 'ai_review'
   *
   * @param status - Raw status value from JSON
   * @returns Normalized TaskStatus value
   */
  private normalizeTaskStatus(status: string): string {
    const normalized = status.toLowerCase().trim();

    // Map legacy statuses to valid TaskStatus values
    const statusMap: Record<string, string> = {
      // Valid statuses (pass through)
      'backlog': 'backlog',
      'in_progress': 'in_progress',
      'ai_review': 'ai_review',
      'human_review': 'human_review',
      'done': 'done',

      // Legacy → backlog
      'pending': 'backlog',
      'planning': 'backlog',
      'planned': 'backlog',
      'todo': 'backlog',
      'new': 'backlog',
      'open': 'backlog',

      // Legacy → in_progress
      'running': 'in_progress',
      'active': 'in_progress',
      'started': 'in_progress',
      'working': 'in_progress',
      'executing': 'in_progress',

      // Legacy → ai_review
      'qa': 'ai_review',
      'qa_review': 'ai_review',
      'testing': 'ai_review',

      // Legacy → human_review
      'review': 'human_review',
      'needs_review': 'human_review',
      'awaiting_review': 'human_review',

      // Legacy → done
      'completed': 'done',
      'approved': 'done',
      'finished': 'done',
      'closed': 'done',
      'merged': 'done',
    };

    const mappedStatus = statusMap[normalized];
    if (mappedStatus) {
      if (mappedStatus !== normalized) {
        console.log(`[MigrationWorker] Normalized status: "${status}" → "${mappedStatus}"`);
      }
      return mappedStatus;
    }

    // Unknown status - default to backlog and log warning
    console.warn(`[MigrationWorker] Unknown status "${status}", defaulting to "backlog"`);
    return 'backlog';
  }

  /**
   * Normalize subtask status values to valid SubtaskStatus
   * Valid values: 'pending' | 'in_progress' | 'completed' | 'failed'
   */
  private normalizeSubtaskStatus(status: string): string {
    const normalized = status.toLowerCase().trim();

    const statusMap: Record<string, string> = {
      // Valid statuses (pass through)
      'pending': 'pending',
      'in_progress': 'in_progress',
      'completed': 'completed',
      'failed': 'failed',

      // Legacy → pending
      'todo': 'pending',
      'planned': 'pending',
      'not_started': 'pending',

      // Legacy → in_progress
      'running': 'in_progress',
      'active': 'in_progress',
      'started': 'in_progress',
      'working': 'in_progress',

      // Legacy → completed
      'done': 'completed',
      'finished': 'completed',
      'success': 'completed',
      'passed': 'completed',

      // Legacy → failed
      'error': 'failed',
      'blocked': 'failed',
      'rejected': 'failed',
    };

    return statusMap[normalized] || 'pending';
  }

  // ============================================
  // New Data Type Migration Methods
  // ============================================

  /**
   * Migrate project_index.json to project_index and project_services tables
   *
   * @param data - Project index data from JSON
   * @param projectPath - Project path
   */
  private migrateProjectIndexWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project in the database
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) {
        console.log(`[MigrationWorker] Failed to migrate project, skipping project_index`);
        return;
      }
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    // Insert project_index record
    const projectRoot = (data.project_root as string) || projectPath;
    const projectType = (data.project_type as string) || 'single';

    const insertIndexStmt = db.prepare(`
      INSERT OR REPLACE INTO project_index (
        project_id, project_root, project_type, infrastructure_json, conventions_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    insertIndexStmt.run(
      projectId,
      projectRoot,
      projectType,
      JSON.stringify(data.infrastructure || {}),
      JSON.stringify(data.conventions || {})
    );

    // Get the project_index id for services
    const indexRow = db.prepare('SELECT id FROM project_index WHERE project_id = ?').get(projectId) as { id: number } | undefined;
    if (!indexRow) {
      console.log(`[MigrationWorker] Failed to get project_index id`);
      return;
    }
    const projectIndexId = indexRow.id;

    // Insert services if present
    const services = data.services as Record<string, Record<string, unknown>> | undefined;
    if (services) {
      const insertServiceStmt = db.prepare(`
        INSERT OR IGNORE INTO project_services (
          project_index_id, service_name, service_path, language, framework, service_type, package_manager, dependencies_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [serviceName, service] of Object.entries(services)) {
        insertServiceStmt.run(
          projectIndexId,
          serviceName,
          (service.path as string) || '',
          (service.language as string) || null,
          (service.framework as string) || null,
          (service.type as string) || null,
          (service.package_manager as string) || null,
          JSON.stringify(service.dependencies || [])
        );
      }
    }

    console.log(`[MigrationWorker] Migrated project_index with ${Object.keys(services || {}).length} services`);
  }

  /**
   * Migrate roadmap.json to roadmaps, roadmap_phases, roadmap_milestones, roadmap_features tables
   *
   * @param data - Roadmap data from JSON
   * @param projectPath - Project path
   */
  private migrateRoadmapWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    const roadmapId = (data.id as string) || `roadmap-${Date.now()}`;
    const projectName = (data.project_name as string) || path.basename(projectPath);

    // Insert roadmap
    const insertRoadmapStmt = db.prepare(`
      INSERT OR REPLACE INTO roadmaps (
        id, project_id, project_name, version, vision, target_audience_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    insertRoadmapStmt.run(
      roadmapId,
      projectId,
      projectName,
      (data.version as string) || null,
      (data.vision as string) || null,
      JSON.stringify(data.target_audience || {}),
      JSON.stringify(data.metadata || {})
    );

    // Insert phases
    const phases = data.phases as Array<Record<string, unknown>> | undefined;
    if (phases) {
      const insertPhaseStmt = db.prepare(`
        INSERT OR IGNORE INTO roadmap_phases (id, roadmap_id, name, description, phase_order, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const insertMilestoneStmt = db.prepare(`
        INSERT OR IGNORE INTO roadmap_milestones (id, phase_id, title, description, status, features_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const phase of phases) {
        const phaseId = (phase.id as string) || `phase-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        insertPhaseStmt.run(
          phaseId,
          roadmapId,
          (phase.name as string) || '',
          (phase.description as string) || null,
          (phase.order as number) || 0,
          (phase.status as string) || 'planned'
        );

        // Insert milestones for this phase
        const milestones = phase.milestones as Array<Record<string, unknown>> | undefined;
        if (milestones) {
          for (const milestone of milestones) {
            const milestoneId = (milestone.id as string) || `milestone-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            insertMilestoneStmt.run(
              milestoneId,
              phaseId,
              (milestone.title as string) || '',
              (milestone.description as string) || null,
              (milestone.status as string) || 'planned',
              JSON.stringify(milestone.features || [])
            );
          }
        }
      }
    }

    // Insert features
    const features = data.features as Array<Record<string, unknown>> | undefined;
    if (features) {
      const insertFeatureStmt = db.prepare(`
        INSERT OR IGNORE INTO roadmap_features (
          id, roadmap_id, phase_id, title, description, rationale, priority, complexity, impact,
          status, dependencies_json, acceptance_criteria_json, user_stories_json, linked_spec_id, competitor_insight_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const feature of features) {
        const featureId = (feature.id as string) || `feature-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        insertFeatureStmt.run(
          featureId,
          roadmapId,
          (feature.phase_id as string) || null,
          (feature.title as string) || '',
          (feature.description as string) || null,
          (feature.rationale as string) || null,
          (feature.priority as string) || null,
          (feature.complexity as string) || null,
          (feature.impact as string) || null,
          (feature.status as string) || 'planned',
          JSON.stringify(feature.dependencies || []),
          JSON.stringify(feature.acceptance_criteria || []),
          JSON.stringify(feature.user_stories || []),
          (feature.linked_spec_id as string) || null,
          JSON.stringify(feature.competitor_insight_ids || [])
        );
      }
    }

    console.log(`[MigrationWorker] Migrated roadmap with ${phases?.length || 0} phases, ${features?.length || 0} features`);
  }

  /**
   * Migrate roadmap_discovery.json to roadmap_discovery table
   *
   * @param data - Roadmap discovery data from JSON
   * @param projectPath - Project path
   */
  private migrateRoadmapDiscoveryWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO roadmap_discovery (
        project_id, project_name, project_type, tech_stack_json, target_audience_json,
        product_vision_json, current_state_json, competitive_context_json, constraints_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      projectId,
      (data.project_name as string) || path.basename(projectPath),
      (data.project_type as string) || null,
      JSON.stringify(data.tech_stack || {}),
      JSON.stringify(data.target_audience || {}),
      JSON.stringify(data.product_vision || {}),
      JSON.stringify(data.current_state || {}),
      JSON.stringify(data.competitive_context || {}),
      JSON.stringify(data.constraints || {}),
      (data.created_at as string) || new Date().toISOString()
    );

    console.log(`[MigrationWorker] Migrated roadmap_discovery`);
  }

  /**
   * Migrate ideation JSON files to ideation_sessions and ideas tables
   *
   * @param data - Ideation data from JSON
   * @param projectPath - Project path
   * @param fileName - Original filename (e.g., 'ideation.json', 'code_improvements_ideas.json')
   */
  private migrateIdeationWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string,
    fileName: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    // Check if this is a main ideation.json or a type-specific file
    if (fileName === 'ideation.json') {
      // Main ideation session file
      const sessionId = (data.id as string) || `ideation-${Date.now()}`;

      const insertSessionStmt = db.prepare(`
        INSERT OR REPLACE INTO ideation_sessions (id, project_id, config_json, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);

      insertSessionStmt.run(
        sessionId,
        projectId,
        JSON.stringify(data.config || {})
      );

      // Insert ideas from the session
      const ideas = data.ideas as Array<Record<string, unknown>> | undefined;
      if (ideas) {
        this.insertIdeas(db, sessionId, ideas);
      }

      console.log(`[MigrationWorker] Migrated ideation session with ${ideas?.length || 0} ideas`);
    } else {
      // Type-specific ideation file (e.g., code_improvements_ideas.json)
      // Extract type from filename
      const ideaType = fileName.replace('_ideas.json', '').replace('.json', '');

      // Create or find session for this type
      const sessionId = `ideation-${ideaType}-${projectId}`;

      const insertSessionStmt = db.prepare(`
        INSERT OR IGNORE INTO ideation_sessions (id, project_id, config_json, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `);

      insertSessionStmt.run(
        sessionId,
        projectId,
        JSON.stringify({ type: ideaType })
      );

      // The file may contain an array of ideas directly or have an 'ideas' property
      const ideas = Array.isArray(data) ? data : (data.ideas as Array<Record<string, unknown>> || [data]);
      this.insertIdeas(db, sessionId, ideas, ideaType);

      console.log(`[MigrationWorker] Migrated ${ideaType} ideation with ${ideas.length} ideas`);
    }
  }

  /**
   * Insert ideas into the ideas table
   *
   * @param db - Database connection
   * @param sessionId - Session ID
   * @param ideas - Array of idea objects
   * @param defaultType - Default idea type if not specified
   */
  private insertIdeas(
    db: Database.Database,
    sessionId: string,
    ideas: Array<Record<string, unknown>>,
    defaultType?: string
  ): void {
    const insertIdeaStmt = db.prepare(`
      INSERT OR IGNORE INTO ideas (
        id, session_id, idea_type, title, description, rationale, estimated_effort,
        implementation_approach, status, builds_upon_json, affected_files_json, existing_patterns_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const idea of ideas) {
      const ideaId = (idea.id as string) || `idea-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      insertIdeaStmt.run(
        ideaId,
        sessionId,
        (idea.type as string) || defaultType || 'general',
        (idea.title as string) || '',
        (idea.description as string) || null,
        (idea.rationale as string) || null,
        (idea.estimated_effort as string) || null,
        (idea.implementation_approach as string) || null,
        (idea.status as string) || 'draft',
        JSON.stringify(idea.builds_upon || []),
        JSON.stringify(idea.affected_files || []),
        JSON.stringify(idea.existing_patterns || []),
        (idea.created_at as string) || new Date().toISOString()
      );
    }
  }

  /**
   * Migrate file_evolution.json to file_evolution and file_snapshots tables
   *
   * @param data - File evolution data from JSON (keyed by file path)
   * @param projectPath - Project path
   */
  private migrateFileEvolutionWithinTransaction(
    data: Record<string, Record<string, unknown>>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    const insertEvolutionStmt = db.prepare(`
      INSERT OR REPLACE INTO file_evolution (
        project_id, file_path, baseline_commit, baseline_captured_at, baseline_content_hash, baseline_snapshot_path,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const insertSnapshotStmt = db.prepare(`
      INSERT OR IGNORE INTO file_snapshots (
        file_evolution_id, task_id, task_intent, started_at, completed_at,
        content_hash_before, content_hash_after, semantic_changes_json, raw_diff
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let fileCount = 0;
    let snapshotCount = 0;

    for (const [filePath, fileData] of Object.entries(data)) {
      // Insert file evolution record
      insertEvolutionStmt.run(
        projectId,
        (fileData.file_path as string) || filePath,
        (fileData.baseline_commit as string) || null,
        (fileData.baseline_captured_at as string) || null,
        (fileData.baseline_content_hash as string) || null,
        (fileData.baseline_snapshot_path as string) || null
      );
      fileCount++;

      // Get the file_evolution id
      const evolutionRow = db.prepare('SELECT id FROM file_evolution WHERE project_id = ? AND file_path = ?')
        .get(projectId, filePath) as { id: number } | undefined;
      if (!evolutionRow) continue;
      const fileEvolutionId = evolutionRow.id;

      // Insert task snapshots
      const snapshots = fileData.task_snapshots as Array<Record<string, unknown>> | undefined;
      if (snapshots) {
        for (const snapshot of snapshots) {
          // Convert raw spec ID to task ID format, and verify the task exists
          let taskId: string | null = null;
          const rawTaskId = snapshot.task_id as string | undefined;
          if (rawTaskId) {
            // Try both formats: "task-{specId}" and raw "{specId}"
            const taskIdWithPrefix = rawTaskId.startsWith('task-') ? rawTaskId : `task-${rawTaskId}`;
            const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskIdWithPrefix);
            if (taskExists) {
              taskId = taskIdWithPrefix;
            }
            // If task doesn't exist, leave taskId as null (foreign key allows null)
          }

          insertSnapshotStmt.run(
            fileEvolutionId,
            taskId,
            (snapshot.task_intent as string) || null,
            (snapshot.started_at as string) || null,
            (snapshot.completed_at as string) || null,
            (snapshot.content_hash_before as string) || null,
            (snapshot.content_hash_after as string) || null,
            JSON.stringify(snapshot.semantic_changes || []),
            (snapshot.raw_diff as string) || null
          );
          snapshotCount++;
        }
      }
    }

    console.log(`[MigrationWorker] Migrated file_evolution: ${fileCount} files, ${snapshotCount} snapshots`);
  }

  /**
   * Migrate file-timelines JSON files to file_timelines and timeline_task_views tables
   *
   * @param data - File timeline data from JSON
   * @param projectPath - Project path
   */
  private migrateFileTimelineWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    const filePath = (data.file_path as string) || '';
    if (!filePath) {
      console.log(`[MigrationWorker] No file_path in timeline data, skipping`);
      return;
    }

    // Insert file timeline
    const insertTimelineStmt = db.prepare(`
      INSERT OR REPLACE INTO file_timelines (
        project_id, file_path, main_branch_history_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, datetime('now'))
    `);

    insertTimelineStmt.run(
      projectId,
      filePath,
      JSON.stringify(data.main_branch_history || []),
      (data.created_at as string) || new Date().toISOString()
    );

    // Get the timeline id
    const timelineRow = db.prepare('SELECT id FROM file_timelines WHERE project_id = ? AND file_path = ?')
      .get(projectId, filePath) as { id: number } | undefined;
    if (!timelineRow) return;
    const timelineId = timelineRow.id;

    // Insert task views
    const taskViews = data.task_views as Record<string, Record<string, unknown>> | undefined;
    if (taskViews) {
      const insertTaskViewStmt = db.prepare(`
        INSERT OR IGNORE INTO timeline_task_views (
          timeline_id, task_id, branch_point_commit, branch_point_content_hash, branch_point_timestamp,
          worktree_content_hash, worktree_last_modified, task_title, task_description, from_plan,
          commits_behind_main, status, merged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [rawTaskId, view] of Object.entries(taskViews)) {
        // Convert raw spec ID to task ID format, and verify the task exists
        // (timeline_task_views has FK constraint to tasks with ON DELETE CASCADE)
        const taskIdWithPrefix = rawTaskId.startsWith('task-') ? rawTaskId : `task-${rawTaskId}`;
        const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskIdWithPrefix);
        if (!taskExists) {
          console.log(`[MigrationWorker] Skipping task view for non-existent task: ${rawTaskId}`);
          continue;
        }

        const branchPoint = view.branch_point as Record<string, unknown> | undefined;
        const worktreeState = view.worktree_state as Record<string, unknown> | undefined;
        const taskIntent = view.task_intent as Record<string, unknown> | undefined;

        insertTaskViewStmt.run(
          timelineId,
          taskIdWithPrefix,
          branchPoint?.commit_hash || null,
          branchPoint?.content ? (branchPoint.content as string).substring(0, 64) : null, // Hash content if needed
          branchPoint?.timestamp || null,
          worktreeState?.content ? (worktreeState.content as string).substring(0, 64) : null,
          worktreeState?.last_modified || null,
          taskIntent?.title || null,
          taskIntent?.description || null,
          taskIntent?.from_plan ? 1 : 0,
          (view.commits_behind_main as number) || 0,
          (view.status as string) || 'active',
          (view.merged_at as string) || null
        );
      }
    }

    console.log(`[MigrationWorker] Migrated file timeline: ${filePath}`);
  }

  /**
   * Migrate insight session JSON files to insight_sessions and session_messages tables
   *
   * @param data - Insight session data from JSON
   * @param projectPath - Project path
   */
  private migrateInsightSessionWithinTransaction(
    data: Record<string, unknown>,
    projectPath: string
  ): void {
    const db = getDatabaseConnection().getConnection();

    // Look up or create the project
    let projectRow = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
    if (!projectRow) {
      const projectId = this.migrateProjectToDatabase(db, projectPath);
      if (!projectId) return;
      projectRow = { id: projectId };
    }
    const projectId = projectRow.id;

    const sessionId = (data.id as string) || `session-${Date.now()}`;

    // Insert session
    const insertSessionStmt = db.prepare(`
      INSERT OR REPLACE INTO insight_sessions (id, project_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertSessionStmt.run(
      sessionId,
      projectId,
      (data.title as string) || null,
      (data.createdAt as string) || new Date().toISOString(),
      (data.updatedAt as string) || new Date().toISOString()
    );

    // Insert messages
    const messages = data.messages as Array<Record<string, unknown>> | undefined;
    if (messages) {
      const insertMessageStmt = db.prepare(`
        INSERT OR IGNORE INTO session_messages (id, session_id, role, content, timestamp, tools_used_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const message of messages) {
        const messageId = (message.id as string) || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        insertMessageStmt.run(
          messageId,
          sessionId,
          (message.role as string) || 'user',
          (message.content as string) || '',
          (message.timestamp as string) || new Date().toISOString(),
          JSON.stringify(message.toolsUsed || [])
        );
      }
    }

    console.log(`[MigrationWorker] Migrated insight session: ${sessionId} with ${messages?.length || 0} messages`);
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
