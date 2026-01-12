import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';

/**
 * Migration marker stored in .auto-claude/.migration-status.json
 */
interface MigrationMarker {
  projectPath: string;
  migratedAt: string; // ISO timestamp
  migratedFiles: string[]; // ['tasks.json', 'implementation_plan.json', 'task_logs.json']
  version: string; // Migration schema version
}

/**
 * Tracks migration completion status for projects to ensure idempotency
 */
export class MigrationTracker {
  private readonly MIGRATION_MARKER_FILE = '.migration-status.json';
  private readonly MIGRATION_VERSION = '1.0.0';
  private readonly EXPECTED_FILES = ['tasks.json', 'implementation_plan.json', 'task_logs.json'];

  /**
   * Check if a project has already been migrated
   * @param projectPath - Absolute path to the project directory
   * @returns true if all expected files have been migrated
   */
  hasMigrated(projectPath: string): boolean {
    const markerPath = this.getMarkerPath(projectPath);

    if (!existsSync(markerPath)) {
      return false;
    }

    try {
      const content = readFileSync(markerPath, 'utf-8');
      const marker: MigrationMarker = JSON.parse(content);

      // Check if all expected files have been migrated
      const allMigrated = this.EXPECTED_FILES.every(file => marker.migratedFiles.includes(file));

      return allMigrated;
    } catch (error) {
      console.error('[MigrationTracker] Failed to read migration marker:', error);
      return false;
    }
  }

  /**
   * Mark a migration as complete
   * @param projectPath - Absolute path to the project directory
   * @param migratedFiles - Array of filenames that were successfully migrated
   */
  markMigrationComplete(projectPath: string, migratedFiles: string[]): void {
    const markerPath = this.getMarkerPath(projectPath);

    // Ensure .auto-claude directory exists
    const autoBuildDir = path.join(projectPath, '.auto-claude');
    if (!existsSync(autoBuildDir)) {
      mkdirSync(autoBuildDir, { recursive: true });
    }

    const marker: MigrationMarker = {
      projectPath,
      migratedAt: new Date().toISOString(),
      migratedFiles,
      version: this.MIGRATION_VERSION
    };

    try {
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
      console.log(`[MigrationTracker] Migration marked complete for ${projectPath}`);
    } catch (error) {
      console.error('[MigrationTracker] Failed to write migration marker:', error);
      throw error;
    }
  }

  /**
   * Get migration status for a project
   * @param projectPath - Absolute path to the project directory
   * @returns Migration marker object or null if not migrated
   */
  getMigrationStatus(projectPath: string): MigrationMarker | null {
    const markerPath = this.getMarkerPath(projectPath);

    if (!existsSync(markerPath)) {
      return null;
    }

    try {
      const content = readFileSync(markerPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[MigrationTracker] Failed to read migration status:', error);
      return null;
    }
  }

  /**
   * Clear migration marker (for testing or forcing re-migration)
   * @param projectPath - Absolute path to the project directory
   */
  clearMigrationMarker(projectPath: string): void {
    const markerPath = this.getMarkerPath(projectPath);

    if (existsSync(markerPath)) {
      try {
        unlinkSync(markerPath);
        console.log(`[MigrationTracker] Migration marker cleared for ${projectPath}`);
      } catch (error) {
        console.error('[MigrationTracker] Failed to clear migration marker:', error);
        throw error;
      }
    }
  }

  /**
   * Get the path to the migration marker file
   * @param projectPath - Absolute path to the project directory
   * @returns Absolute path to the .migration-status.json file
   */
  private getMarkerPath(projectPath: string): string {
    return path.join(projectPath, '.auto-claude', this.MIGRATION_MARKER_FILE);
  }
}

/**
 * Singleton instance
 */
let migrationTrackerInstance: MigrationTracker | null = null;

/**
 * Get the singleton MigrationTracker instance
 * @returns MigrationTracker instance
 */
export function getMigrationTracker(): MigrationTracker {
  if (!migrationTrackerInstance) {
    migrationTrackerInstance = new MigrationTracker();
  }
  return migrationTrackerInstance;
}
