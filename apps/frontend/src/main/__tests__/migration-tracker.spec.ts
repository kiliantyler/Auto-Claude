/**
 * Unit tests for Migration Tracker
 * Tests migration status tracking and marker file management
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';

// Test directories
const TEST_DIR = '/tmp/migration-tracker-test';
const TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');

// Setup test directories
function setupTestDirs(): void {
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
  mkdirSync(path.join(TEST_PROJECT_PATH, '.auto-claude'), { recursive: true });
}

// Cleanup test directories
function cleanupTestDirs(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('MigrationTracker', () => {
  beforeEach(async () => {
    cleanupTestDirs();
    setupTestDirs();
    vi.resetModules();
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
  });

  describe('hasMigrated', () => {
    it('should return false when marker file does not exist', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      const result = tracker.hasMigrated(TEST_PROJECT_PATH);

      expect(result).toBe(false);
    });

    it('should return false when marker exists but files are incomplete', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create marker with incomplete file list
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      const marker = {
        projectPath: TEST_PROJECT_PATH,
        migratedAt: new Date().toISOString(),
        migratedFiles: ['tasks.json'], // Missing implementation_plan.json and task_logs.json
        version: '1.0.0'
      };
      writeFileSync(markerPath, JSON.stringify(marker));

      const result = tracker.hasMigrated(TEST_PROJECT_PATH);

      expect(result).toBe(false);
    });

    it('should return true when all expected files are migrated', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create marker with complete file list
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      const marker = {
        projectPath: TEST_PROJECT_PATH,
        migratedAt: new Date().toISOString(),
        migratedFiles: ['tasks.json', 'implementation_plan.json', 'task_logs.json'],
        version: '1.0.0'
      };
      writeFileSync(markerPath, JSON.stringify(marker));

      const result = tracker.hasMigrated(TEST_PROJECT_PATH);

      expect(result).toBe(true);
    });

    it('should return false when marker file is corrupted', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create corrupted marker file
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      writeFileSync(markerPath, 'invalid json {{{');

      const result = tracker.hasMigrated(TEST_PROJECT_PATH);

      expect(result).toBe(false);
    });
  });

  describe('markMigrationComplete', () => {
    it('should create marker file with correct structure', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      const migratedFiles = ['tasks.json', 'implementation_plan.json'];
      tracker.markMigrationComplete(TEST_PROJECT_PATH, migratedFiles);

      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(true);

      const content = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(content.projectPath).toBe(TEST_PROJECT_PATH);
      expect(content.migratedFiles).toEqual(migratedFiles);
      expect(content.version).toBe('1.0.0');
      expect(content.migratedAt).toBeDefined();
      expect(new Date(content.migratedAt)).toBeInstanceOf(Date);
    });

    it('should create .auto-claude directory if it does not exist', async () => {
      // Remove .auto-claude directory
      const autoBuildDir = path.join(TEST_PROJECT_PATH, '.auto-claude');
      if (existsSync(autoBuildDir)) {
        rmSync(autoBuildDir, { recursive: true, force: true });
      }

      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      tracker.markMigrationComplete(TEST_PROJECT_PATH, ['tasks.json']);

      expect(existsSync(autoBuildDir)).toBe(true);
      const markerPath = path.join(autoBuildDir, '.migration-status.json');
      expect(existsSync(markerPath)).toBe(true);
    });

    it('should overwrite existing marker file', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create initial marker
      tracker.markMigrationComplete(TEST_PROJECT_PATH, ['tasks.json']);

      // Update with new files
      tracker.markMigrationComplete(TEST_PROJECT_PATH, ['tasks.json', 'implementation_plan.json']);

      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      const content = JSON.parse(readFileSync(markerPath, 'utf-8'));
      expect(content.migratedFiles).toHaveLength(2);
    });

    it('should throw error if write fails', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Use invalid path to force write error
      const invalidPath = '/invalid/path/that/does/not/exist';

      expect(() => {
        tracker.markMigrationComplete(invalidPath, ['tasks.json']);
      }).toThrow();
    });
  });

  describe('getMigrationStatus', () => {
    it('should return null when marker file does not exist', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      const status = tracker.getMigrationStatus(TEST_PROJECT_PATH);

      expect(status).toBeNull();
    });

    it('should return marker data when file exists', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create marker
      const migratedFiles = ['tasks.json', 'implementation_plan.json'];
      tracker.markMigrationComplete(TEST_PROJECT_PATH, migratedFiles);

      const status = tracker.getMigrationStatus(TEST_PROJECT_PATH);

      expect(status).not.toBeNull();
      expect(status?.projectPath).toBe(TEST_PROJECT_PATH);
      expect(status?.migratedFiles).toEqual(migratedFiles);
      expect(status?.version).toBe('1.0.0');
      expect(status?.migratedAt).toBeDefined();
    });

    it('should return null when marker file is corrupted', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create corrupted marker file
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      writeFileSync(markerPath, 'invalid json {{{');

      const status = tracker.getMigrationStatus(TEST_PROJECT_PATH);

      expect(status).toBeNull();
    });
  });

  describe('clearMigrationMarker', () => {
    it('should delete marker file if it exists', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create marker
      tracker.markMigrationComplete(TEST_PROJECT_PATH, ['tasks.json']);

      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      expect(existsSync(markerPath)).toBe(true);

      // Clear marker
      tracker.clearMigrationMarker(TEST_PROJECT_PATH);

      expect(existsSync(markerPath)).toBe(false);
    });

    it('should not throw error if marker file does not exist', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      expect(() => {
        tracker.clearMigrationMarker(TEST_PROJECT_PATH);
      }).not.toThrow();
    });

    it('should throw error if delete fails', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Create marker with wrong permissions
      const markerPath = path.join(TEST_PROJECT_PATH, '.auto-claude', '.migration-status.json');
      writeFileSync(markerPath, '{}');

      // Mock unlink to throw error
      vi.mock('fs', async () => {
        const actual = await vi.importActual('fs') as any;
        return {
          ...actual,
          unlinkSync: vi.fn(() => {
            throw new Error('Permission denied');
          })
        };
      });

      // Re-import after mock
      vi.resetModules();
      const { MigrationTracker: TrackerAfterMock } = await import('../migration-tracker');
      const trackerAfterMock = new TrackerAfterMock();

      expect(() => {
        trackerAfterMock.clearMigrationMarker(TEST_PROJECT_PATH);
      }).toThrow();
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance on multiple calls', async () => {
      const { getMigrationTracker } = await import('../migration-tracker');

      const instance1 = getMigrationTracker();
      const instance2 = getMigrationTracker();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after module reset', async () => {
      const { getMigrationTracker } = await import('../migration-tracker');
      const instance1 = getMigrationTracker();

      vi.resetModules();

      const { getMigrationTracker: getTrackerAfterReset } = await import('../migration-tracker');
      const instance2 = getTrackerAfterReset();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('integration scenarios', () => {
    it('should track full migration lifecycle', async () => {
      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Initially not migrated
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(false);
      expect(tracker.getMigrationStatus(TEST_PROJECT_PATH)).toBeNull();

      // Mark first file migrated
      tracker.markMigrationComplete(TEST_PROJECT_PATH, ['tasks.json']);
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(false); // Not all files

      // Mark all files migrated
      tracker.markMigrationComplete(TEST_PROJECT_PATH, [
        'tasks.json',
        'implementation_plan.json',
        'task_logs.json'
      ]);
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(true);

      const status = tracker.getMigrationStatus(TEST_PROJECT_PATH);
      expect(status?.migratedFiles).toHaveLength(3);

      // Clear marker
      tracker.clearMigrationMarker(TEST_PROJECT_PATH);
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(false);
      expect(tracker.getMigrationStatus(TEST_PROJECT_PATH)).toBeNull();
    });

    it('should handle multiple projects independently', async () => {
      const project2Path = path.join(TEST_DIR, 'test-project-2');
      mkdirSync(project2Path, { recursive: true });
      mkdirSync(path.join(project2Path, '.auto-claude'), { recursive: true });

      const { MigrationTracker } = await import('../migration-tracker');
      const tracker = new MigrationTracker();

      // Mark first project as migrated
      tracker.markMigrationComplete(TEST_PROJECT_PATH, [
        'tasks.json',
        'implementation_plan.json',
        'task_logs.json'
      ]);

      // Second project not migrated
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(true);
      expect(tracker.hasMigrated(project2Path)).toBe(false);

      // Mark second project partially
      tracker.markMigrationComplete(project2Path, ['tasks.json']);
      expect(tracker.hasMigrated(project2Path)).toBe(false);

      // Clear first project
      tracker.clearMigrationMarker(TEST_PROJECT_PATH);
      expect(tracker.hasMigrated(TEST_PROJECT_PATH)).toBe(false);
      expect(tracker.hasMigrated(project2Path)).toBe(false);
    });
  });
});
