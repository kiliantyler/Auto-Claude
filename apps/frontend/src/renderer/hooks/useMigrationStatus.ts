import { useEffect } from 'react';
import { useMigrationStore, type MigrationProgress } from '../stores/migration-store';

/**
 * React hook for managing migration status and IPC event listeners
 *
 * This hook:
 * 1. Sets up IPC listeners for migration:progress events from main process
 * 2. Updates the migration Zustand store when events arrive
 * 3. Provides access to migration status for specific projects via store selectors
 *
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   useMigrationStatus(); // Call once at app root to set up listeners
 *
 *   // Access migration status elsewhere via store
 *   const migration = useMigrationStore(state => state.getMigrationStatus(projectPath));
 * }
 * ```
 *
 * Pattern:
 * - Follows the same pattern as useIpc.ts (event listeners with cleanup)
 * - Updates Zustand store for state management
 * - Automatically handles IPC event lifecycle (setup/teardown)
 */
export function useMigrationStatus(): void {
  const setMigrationProgress = useMigrationStore(
    (state) => state.setMigrationProgress
  );
  const setMigrationComplete = useMigrationStore(
    (state) => state.setMigrationComplete
  );
  const setMigrationError = useMigrationStore(
    (state) => state.setMigrationError
  );
  const setMigrationStarted = useMigrationStore(
    (state) => state.setMigrationStarted
  );

  useEffect(() => {
    // Set up listener for migration progress events from main process
    // Main process sends events via: mainWindow.webContents.send('migration:progress', progress)
    const cleanupProgress = window.electronAPI.onMigrationProgress(
      (progress: MigrationProgress) => {
        const { projectPath, status, percentage, currentFile, error } = progress;

        if (status === 'running') {
          // First progress event - mark as started
          if (percentage === 0 && !currentFile) {
            setMigrationStarted(projectPath);
          } else {
            // Ongoing progress - update with current file and percentage
            setMigrationProgress(projectPath, percentage, currentFile || '');
          }
        } else if (status === 'completed') {
          // Migration completed successfully
          setMigrationComplete(projectPath);
        } else if (status === 'failed') {
          // Migration failed with error
          setMigrationError(projectPath, error || 'Unknown error');
        }
      }
    );

    // Cleanup on unmount
    return () => {
      cleanupProgress();
    };
  }, [
    setMigrationProgress,
    setMigrationComplete,
    setMigrationError,
    setMigrationStarted,
  ]);
}

/**
 * Hook to get migration status for a specific project
 *
 * This is a convenience hook that wraps the store selector for cleaner usage.
 *
 * @param projectPath - Path to the project
 * @returns Migration progress data or null if no migration in progress/completed
 *
 * Usage:
 * ```tsx
 * function ProjectView({ projectPath }: { projectPath: string }) {
 *   const migration = useProjectMigrationStatus(projectPath);
 *
 *   if (migration?.status === 'running') {
 *     return <MigrationProgress progress={migration.progress} />;
 *   }
 *   // ...
 * }
 * ```
 */
export function useProjectMigrationStatus(
  projectPath: string
): MigrationProgress | null {
  return useMigrationStore((state) => state.getMigrationStatus(projectPath));
}

/**
 * Hook to check if any migration is currently running
 *
 * Useful for displaying global loading states or disabling actions during migration.
 *
 * @returns true if any project migration is running
 *
 * Usage:
 * ```tsx
 * function GlobalHeader() {
 *   const isAnyMigrationRunning = useIsAnyMigrationRunning();
 *
 *   return (
 *     <header>
 *       {isAnyMigrationRunning && <MigrationIndicator />}
 *     </header>
 *   );
 * }
 * ```
 */
export function useIsAnyMigrationRunning(): boolean {
  return useMigrationStore((state) => state.isAnyMigrationRunning());
}

/**
 * Hook to check if any migration has failed
 *
 * Useful for displaying error indicators or triggering error recovery flows.
 *
 * @returns true if any project migration has failed
 *
 * Usage:
 * ```tsx
 * function ErrorBoundary() {
 *   const hasAnyMigrationFailed = useHasAnyMigrationFailed();
 *
 *   if (hasAnyMigrationFailed) {
 *     return <MigrationErrorNotification />;
 *   }
 *   // ...
 * }
 * ```
 */
export function useHasAnyMigrationFailed(): boolean {
  return useMigrationStore((state) => state.hasAnyMigrationFailed());
}
