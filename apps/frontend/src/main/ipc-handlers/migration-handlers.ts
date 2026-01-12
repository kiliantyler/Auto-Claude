/**
 * Migration IPC Handlers
 * ======================
 *
 * IPC handlers for JSON-to-SQLite migration operations.
 * These handlers expose the MigrationWorker and MigrationTracker to the renderer process.
 *
 * Available handlers:
 * - migration:start - Trigger migration for a project
 * - migration:status - Get migration status for a project
 * - migration:progress - Push event for real-time progress updates (main → renderer)
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { IPCResult } from '../../shared/types';
import { getMigrationWorker, type MigrationProgress } from '../migration-worker';
import { getMigrationTracker } from '../migration-tracker';

// IPC channel names for migration operations
export const MIGRATION_CHANNELS = {
  START: 'migration:start',
  STATUS: 'migration:status',
  PROGRESS: 'migration:progress',
} as const;

/**
 * Migration status response
 */
interface MigrationStatusResponse {
  hasMigrated: boolean;
  projectPath: string;
  migratedAt?: string;
  migratedFiles?: string[];
  version?: string;
}

/**
 * Register migration IPC handlers
 *
 * Follows the same pattern as analytics-handlers.ts - simple registration function
 * that sets up all handlers when called.
 *
 * @param getMainWindow - Function to get the main BrowserWindow for sending progress events
 */
export function registerMigrationHandlers(getMainWindow: () => BrowserWindow | null): void {
  console.log('[Migration Handlers] Registering migration IPC handlers');

  /**
   * Start migration for a project
   *
   * Triggers the migration worker to migrate JSON files to SQLite.
   * Emits real-time progress updates via migration:progress channel.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns IPCResult with success status
   */
  ipcMain.handle(
    MIGRATION_CHANNELS.START,
    async (_, projectPath: string): Promise<IPCResult<void>> => {
      console.log('[Migration Handlers] START called for project:', projectPath);

      if (!projectPath) {
        return { success: false, error: 'Project path is required' };
      }

      try {
        const worker = getMigrationWorker();
        const mainWindow = getMainWindow();

        // Start migration with progress callback
        await worker.migrate(projectPath, (progress: MigrationProgress) => {
          // Send progress updates to renderer via push event
          if (mainWindow) {
            mainWindow.webContents.send(MIGRATION_CHANNELS.PROGRESS, progress);
          }
        });

        console.log('[Migration Handlers] START completed successfully for:', projectPath);
        return { success: true };
      } catch (error) {
        console.error('[Migration Handlers] START failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start migration',
        };
      }
    }
  );

  /**
   * Get migration status for a project
   *
   * Checks if a project has already been migrated by reading the marker file.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns MigrationStatusResponse with migration status details
   */
  ipcMain.handle(
    MIGRATION_CHANNELS.STATUS,
    async (_, projectPath: string): Promise<IPCResult<MigrationStatusResponse>> => {
      console.log('[Migration Handlers] STATUS called for project:', projectPath);

      if (!projectPath) {
        return { success: false, error: 'Project path is required' };
      }

      try {
        const tracker = getMigrationTracker();
        const hasMigrated = tracker.hasMigrated(projectPath);
        const migrationStatus = tracker.getMigrationStatus(projectPath);

        const response: MigrationStatusResponse = {
          hasMigrated,
          projectPath,
        };

        // Add migration details if available
        if (migrationStatus) {
          response.migratedAt = migrationStatus.migratedAt;
          response.migratedFiles = migrationStatus.migratedFiles;
          response.version = migrationStatus.version;
        }

        console.log('[Migration Handlers] STATUS returning:', response);
        return { success: true, data: response };
      } catch (error) {
        console.error('[Migration Handlers] STATUS failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get migration status',
        };
      }
    }
  );

  console.log('[Migration Handlers] Migration IPC handlers registered successfully');
}
