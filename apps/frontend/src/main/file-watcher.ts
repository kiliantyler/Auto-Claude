import chokidar, { FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { ImplementationPlan } from '../shared/types';

interface WatcherInfo {
  taskId: string;
  watcher: FSWatcher;
  planPath: string;
  // Optional secondary watcher for worktree directory
  worktreeWatcher?: FSWatcher;
  worktreePlanPath?: string;
}

/**
 * Watches implementation_plan.json files for real-time progress updates.
 * Supports watching both main project and worktree directories.
 */
export class FileWatcher extends EventEmitter {
  private watchers: Map<string, WatcherInfo> = new Map();

  /**
   * Start watching a task's implementation plan.
   *
   * @param taskId - The task identifier
   * @param specDir - The main project's spec directory
   * @param worktreeSpecDir - Optional worktree spec directory (where actual changes happen)
   */
  async watch(taskId: string, specDir: string, worktreeSpecDir?: string): Promise<void> {
    // Stop any existing watcher for this task
    await this.unwatch(taskId);

    const planPath = path.join(specDir, 'implementation_plan.json');

    // Check if main plan file exists
    if (!existsSync(planPath)) {
      this.emit('error', taskId, `Plan file not found: ${planPath}`);
      return;
    }

    // Create watcher with settings to handle frequent writes
    const watcher = chokidar.watch(planPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    // Store watcher info
    const watcherInfo: WatcherInfo = {
      taskId,
      watcher,
      planPath
    };
    this.watchers.set(taskId, watcherInfo);

    // Helper to emit progress from a plan path
    const emitProgress = (pathToRead: string) => {
      try {
        const content = readFileSync(pathToRead, 'utf-8');
        const plan: ImplementationPlan = JSON.parse(content);
        this.emit('progress', taskId, plan);
      } catch {
        // File might be in the middle of being written
        // Ignore parse errors, next change event will have complete file
      }
    };

    // Handle main file changes
    watcher.on('change', () => emitProgress(planPath));

    // Handle errors
    watcher.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', taskId, message);
    });

    // Also watch worktree directory if provided and different from main
    if (worktreeSpecDir && worktreeSpecDir !== specDir) {
      const worktreePlanPath = path.join(worktreeSpecDir, 'implementation_plan.json');

      if (existsSync(worktreePlanPath)) {
        const worktreeWatcher = chokidar.watch(worktreePlanPath, {
          persistent: true,
          ignoreInitial: true,
          awaitWriteFinish: {
            stabilityThreshold: 300,
            pollInterval: 100
          }
        });

        // Store worktree watcher info
        watcherInfo.worktreeWatcher = worktreeWatcher;
        watcherInfo.worktreePlanPath = worktreePlanPath;

        // Handle worktree file changes - this is where real-time updates come from
        worktreeWatcher.on('change', () => emitProgress(worktreePlanPath));

        worktreeWatcher.on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', taskId, `Worktree watcher error: ${message}`);
        });

        // Read initial state from worktree (more current during active builds)
        emitProgress(worktreePlanPath);
      }
    }

    // Read and emit initial state from main (fallback)
    emitProgress(planPath);
  }

  /**
   * Stop watching a task
   */
  async unwatch(taskId: string): Promise<void> {
    const watcherInfo = this.watchers.get(taskId);
    if (watcherInfo) {
      await watcherInfo.watcher.close();
      // Also close worktree watcher if it exists
      if (watcherInfo.worktreeWatcher) {
        await watcherInfo.worktreeWatcher.close();
      }
      this.watchers.delete(taskId);
    }
  }

  /**
   * Stop all watchers
   */
  async unwatchAll(): Promise<void> {
    const closePromises = Array.from(this.watchers.values()).map(
      async (info) => {
        await info.watcher.close();
        // Also close worktree watcher if it exists
        if (info.worktreeWatcher) {
          await info.worktreeWatcher.close();
        }
      }
    );
    await Promise.all(closePromises);
    this.watchers.clear();
  }

  /**
   * Check if a task is being watched
   */
  isWatching(taskId: string): boolean {
    return this.watchers.has(taskId);
  }

  /**
   * Get current plan state for a task.
   * Prefers worktree plan if available (more current during active builds).
   */
  getCurrentPlan(taskId: string): ImplementationPlan | null {
    const watcherInfo = this.watchers.get(taskId);
    if (!watcherInfo) return null;

    // Try worktree plan first (more current during active builds)
    if (watcherInfo.worktreePlanPath && existsSync(watcherInfo.worktreePlanPath)) {
      try {
        const content = readFileSync(watcherInfo.worktreePlanPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        // Fall through to main plan
      }
    }

    // Fall back to main plan
    try {
      const content = readFileSync(watcherInfo.planPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
}

// Singleton instance
export const fileWatcher = new FileWatcher();
