import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getProjectTaskStorage, withProjectTransaction } from '../../task-storage';

/**
 * Register task archive handlers
 */
export function registerTaskArchiveHandlers(): void {
  /**
   * Archive tasks
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_ARCHIVE,
    async (
      _,
      projectId: string,
      taskIds: string[],
      version?: string
    ): Promise<IPCResult<boolean>> => {
      console.warn('[IPC] TASK_ARCHIVE called with projectId:', projectId, 'taskIds:', taskIds);

      try {
        // Look up project first
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // 1. Update JSON files via project store
        const result = projectStore.archiveTasks(projectId, taskIds, version);

        if (!result) {
          console.error('[IPC] TASK_ARCHIVE failed to update JSON files');
          return { success: false, error: 'Failed to archive tasks' };
        }

        // 2. DUAL-WRITE: Update SQLite database using transaction for atomic operation
        const archivedAt = new Date().toISOString();
        try {
          withProjectTransaction(project.path, () => {
            const taskStorage = getProjectTaskStorage(project.path);
            for (const taskId of taskIds) {
              const task = taskStorage.getTask(taskId);
              if (task) {
                // Update task metadata with archive information
                taskStorage.updateTask(taskId, {
                  metadata: {
                    ...task.metadata,
                    archivedAt: archivedAt,
                    archivedInVersion: version,
                  },
                });
              } else {
                console.warn(`[TASK_ARCHIVE] Task not found in database: ${taskId} (skipping)`);
              }
            }
          });
          console.warn(`[TASK_ARCHIVE] Successfully archived ${taskIds.length} tasks in SQLite database (transaction committed)`);
        } catch (dbError) {
          console.error('[TASK_ARCHIVE] Failed to update SQLite database (continuing):', dbError);
          // Continue - JSON files are already updated
        }

        console.warn('[IPC] TASK_ARCHIVE success');
        return { success: true, data: true };
      } catch (error) {
        console.error('[IPC] TASK_ARCHIVE error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to archive tasks',
        };
      }
    }
  );

  /**
   * Unarchive tasks
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UNARCHIVE,
    async (_, projectId: string, taskIds: string[]): Promise<IPCResult<boolean>> => {
      console.warn('[IPC] TASK_UNARCHIVE called with projectId:', projectId, 'taskIds:', taskIds);

      try {
        // Look up project first
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // 1. Update JSON files via project store
        const result = projectStore.unarchiveTasks(projectId, taskIds);

        if (!result) {
          console.error('[IPC] TASK_UNARCHIVE failed to update JSON files');
          return { success: false, error: 'Failed to unarchive tasks' };
        }

        // 2. DUAL-WRITE: Update SQLite database using transaction for atomic operation
        try {
          withProjectTransaction(project.path, () => {
            const taskStorage = getProjectTaskStorage(project.path);
            for (const taskId of taskIds) {
              const task = taskStorage.getTask(taskId);
              if (task) {
                // Remove archive information from task metadata
                const { archivedAt, archivedInVersion, ...remainingMetadata } = task.metadata || {};
                taskStorage.updateTask(taskId, {
                  metadata: remainingMetadata,
                });
              } else {
                console.warn(`[TASK_UNARCHIVE] Task not found in database: ${taskId} (skipping)`);
              }
            }
          });
          console.warn(`[TASK_UNARCHIVE] Successfully unarchived ${taskIds.length} tasks in SQLite database (transaction committed)`);
        } catch (dbError) {
          console.error('[TASK_UNARCHIVE] Failed to update SQLite database (continuing):', dbError);
          // Continue - JSON files are already updated
        }

        console.warn('[IPC] TASK_UNARCHIVE success');
        return { success: true, data: true };
      } catch (error) {
        console.error('[IPC] TASK_UNARCHIVE error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to unarchive tasks',
        };
      }
    }
  );
}
