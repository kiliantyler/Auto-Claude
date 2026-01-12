import { ipcRenderer } from 'electron';
import { MIGRATION_CHANNELS } from '../../main/ipc-handlers/migration-handlers';
import type { IPCResult } from '../../shared/types';

/**
 * Migration progress data from main process
 */
export interface MigrationProgress {
  projectPath: string;
  status: 'running' | 'completed' | 'failed';
  percentage: number; // 0-100
  currentFile: string | null; // Current file being migrated
  filesCompleted: number; // Number of files successfully migrated
  totalFiles: number; // Total files to migrate (always 3)
  error?: string; // Error message if status is 'failed'
}

/**
 * Migration status response
 */
export interface MigrationStatusResponse {
  hasMigrated: boolean;
  projectPath: string;
  migratedAt?: string;
  migratedFiles?: string[];
  version?: string;
}

/**
 * Migration API - IPC interface for JSON-to-SQLite migration operations
 *
 * Provides methods to:
 * - Start migration for a project
 * - Check migration status
 * - Listen to real-time progress updates
 *
 * Pattern: Follows the same structure as task-api.ts and analytics-api.ts
 */
export interface MigrationAPI {
  /**
   * Start migration for a project
   *
   * Triggers the migration worker to migrate JSON files to SQLite.
   * Progress updates will be sent via onMigrationProgress listener.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns Promise with success/error status
   */
  startMigration: (projectPath: string) => Promise<IPCResult<void>>;

  /**
   * Get migration status for a project
   *
   * Checks if a project has already been migrated by reading the marker file.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns Migration status details
   */
  getMigrationStatus: (
    projectPath: string
  ) => Promise<IPCResult<MigrationStatusResponse>>;

  /**
   * Listen for migration progress events
   *
   * The main process sends real-time progress updates during migration.
   * Use this to update UI components (progress bars, spinners, etc.)
   *
   * @param callback - Function called with progress data
   * @returns Cleanup function to remove listener
   *
   * Example:
   * ```ts
   * const cleanup = window.electronAPI.onMigrationProgress((progress) => {
   *   console.log(`${progress.percentage}% - ${progress.currentFile}`);
   * });
   * // Later: cleanup();
   * ```
   */
  onMigrationProgress: (
    callback: (progress: MigrationProgress) => void
  ) => () => void;
}

/**
 * Create the Migration API implementation
 *
 * Pattern: Same as createTaskAPI() and createAnalyticsAPI()
 */
export const createMigrationAPI = (): MigrationAPI => ({
  // Start migration
  startMigration: (projectPath: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke(MIGRATION_CHANNELS.START, projectPath),

  // Get migration status
  getMigrationStatus: (
    projectPath: string
  ): Promise<IPCResult<MigrationStatusResponse>> =>
    ipcRenderer.invoke(MIGRATION_CHANNELS.STATUS, projectPath),

  // Event listener for progress updates
  onMigrationProgress: (
    callback: (progress: MigrationProgress) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: MigrationProgress
    ): void => {
      callback(progress);
    };

    ipcRenderer.on(MIGRATION_CHANNELS.PROGRESS, handler);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener(MIGRATION_CHANNELS.PROGRESS, handler);
    };
  },
});
