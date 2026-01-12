/**
 * MigrationProgress Component
 *
 * Non-intrusive progress indicator for JSON-to-SQLite migration.
 * Displays in bottom-right corner with current file and progress percentage.
 */
import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../lib/utils';
import { Progress } from './ui/progress';
import { Card, CardContent } from './ui/card';
import { useIsAnyMigrationRunning } from '../hooks/useMigrationStatus';
import { useMigrationStore } from '../stores/migration-store';

interface MigrationProgressProps {
  className?: string;
}

/**
 * MigrationProgress displays a compact progress indicator for ongoing migrations.
 *
 * Features:
 * - Only visible when a migration is running
 * - Shows current file being migrated
 * - Displays progress percentage and animated progress bar
 * - Fixed position in bottom-right corner (non-intrusive)
 * - Smooth transitions and animations
 *
 * Usage:
 * ```tsx
 * <MigrationProgress />
 * ```
 *
 * The component automatically reads migration state from the Zustand store
 * and only renders when migrations are active.
 */
export const MigrationProgress: React.FC<MigrationProgressProps> = ({ className }) => {
  const isRunning = useIsAnyMigrationRunning();
  const runningMigrations = useMigrationStore(
    useShallow((state) =>
      Object.keys(state.migrations).filter(
        (path) => state.migrations[path].status === 'running'
      )
    )
  );
  const migrations = useMigrationStore((state) => state.migrations);

  // Only render if there's an active migration
  if (!isRunning || runningMigrations.length === 0) {
    return null;
  }

  // Get the first running migration (should only be one due to queue)
  const projectPath = runningMigrations[0];
  const migration = migrations[projectPath];

  if (!migration) {
    return null;
  }

  const { progress, currentFile } = migration;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-50 animate-in slide-in-from-bottom-5 fade-in',
        className
      )}
    >
      <Card className="shadow-lg border-border bg-card min-w-[320px]">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Animated spinner */}
            <div className="flex-shrink-0 mt-0.5">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-foreground">Migrating to SQLite</p>
                <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                  {Math.round(progress)}%
                </span>
              </div>

              {/* Progress bar */}
              <Progress value={progress} className="h-1.5 mb-2" animated />

              {/* Current file */}
              {currentFile && (
                <p className="text-xs text-muted-foreground truncate" title={currentFile}>
                  {currentFile}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

MigrationProgress.displayName = 'MigrationProgress';
