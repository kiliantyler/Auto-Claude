import { ipcMain, dialog } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { IPCResult, Task } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { projectStore } from '../../project-store';
import { getProjectTaskStorage } from '../../task-storage';

/**
 * Register task export/import handlers for debugging and recovery
 */
export function registerTaskExportHandlers(): void {
  /**
   * Export all tasks to JSON backup file
   * Saves to .auto-claude/backups/tasks-{timestamp}.json
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_EXPORT,
    async (_, projectId: string): Promise<IPCResult<{ path: string; taskCount: number }>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Create backups directory
        const backupDir = path.join(project.path, '.auto-claude', 'backups');
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }

        // Generate backup filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `tasks-${timestamp}.json`);

        // Read all tasks from project-local database
        const storage = getProjectTaskStorage(project.path);
        const tasks = storage.listTasks(projectId);

        // Export tasks to JSON file
        const exportData = {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          projectId: projectId,
          projectName: project.name,
          projectPath: project.path,
          taskCount: tasks.length,
          tasks: tasks.map(task => ({
            // Core task fields
            id: task.id,
            specId: task.specId,
            projectId: task.projectId,
            title: task.title,
            description: task.description,
            status: task.status,
            reviewReason: task.reviewReason,

            // Subtasks and execution data
            subtasks: task.subtasks,
            qaReport: task.qaReport,
            logs: task.logs,
            executionProgress: task.executionProgress,

            // Metadata
            metadata: task.metadata,

            // Release and staging info
            releasedInVersion: task.releasedInVersion,
            stagedInMainProject: task.stagedInMainProject,
            stagedAt: task.stagedAt,

            // Location and path info
            location: task.location,
            specsPath: task.specsPath,

            // Timestamps
            createdAt: task.createdAt,
            updatedAt: task.updatedAt
          }))
        };

        writeFileSync(backupPath, JSON.stringify(exportData, null, 2));

        console.log(`[TASK_EXPORT] Exported ${tasks.length} tasks to: ${backupPath}`);

        return {
          success: true,
          data: {
            path: backupPath,
            taskCount: tasks.length
          }
        };
      } catch (error) {
        console.error('[TASK_EXPORT] Export failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Export failed'
        };
      }
    }
  );

  /**
   * Import tasks from JSON backup file
   * Restores tasks to SQLite database (and optionally JSON files if dual-write enabled)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_IMPORT,
    async (_, projectId: string, backupPath?: string): Promise<IPCResult<{ taskCount: number; imported: number; skipped: number }>> => {
      try {
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // If no path provided, show file picker dialog
        let importPath = backupPath;
        if (!importPath) {
          const result = await dialog.showOpenDialog({
            title: 'Select Task Backup File',
            defaultPath: path.join(project.path, '.auto-claude', 'backups'),
            filters: [
              { name: 'JSON Backup Files', extensions: ['json'] }
            ],
            properties: ['openFile']
          });

          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: 'Import canceled' };
          }

          importPath = result.filePaths[0];
        }

        // Read and parse backup file
        if (!existsSync(importPath)) {
          return { success: false, error: 'Backup file not found' };
        }

        const backupContent = readFileSync(importPath, 'utf-8');
        const backupData = JSON.parse(backupContent);

        // Validate backup structure
        if (!backupData.version || !backupData.tasks || !Array.isArray(backupData.tasks)) {
          return { success: false, error: 'Invalid backup file format' };
        }

        // Get current tasks from project-local database to check for duplicates
        const storage = getProjectTaskStorage(project.path);
        const existingTasks = storage.listTasks(projectId);
        const existingTaskIds = new Set(existingTasks.map(t => t.id));

        let imported = 0;
        let skipped = 0;

        // Import each task
        for (const taskData of backupData.tasks) {
          try {
            // Skip if task already exists
            if (existingTaskIds.has(taskData.id)) {
              console.log(`[TASK_IMPORT] Skipping existing task: ${taskData.id}`);
              skipped++;
              continue;
            }

            // Reconstruct Task object with proper types
            const task: Task = {
              id: taskData.id,
              specId: taskData.specId,
              projectId: projectId, // Use current project ID
              title: taskData.title,
              description: taskData.description,
              status: taskData.status,
              reviewReason: taskData.reviewReason,
              subtasks: taskData.subtasks || [],
              qaReport: taskData.qaReport,
              logs: taskData.logs || [],
              executionProgress: taskData.executionProgress,
              metadata: taskData.metadata,
              releasedInVersion: taskData.releasedInVersion,
              stagedInMainProject: taskData.stagedInMainProject,
              stagedAt: taskData.stagedAt,
              location: taskData.location,
              specsPath: taskData.specsPath,
              createdAt: new Date(taskData.createdAt),
              updatedAt: new Date(taskData.updatedAt)
            };

            // Create task in database
            storage.createTask(task);

            imported++;
            console.log(`[TASK_IMPORT] Imported task: ${task.id} (${task.specId})`);
          } catch (taskError) {
            console.error(`[TASK_IMPORT] Failed to import task ${taskData.id}:`, taskError);
            skipped++;
          }
        }

        console.log(`[TASK_IMPORT] Import complete: ${imported} imported, ${skipped} skipped`);

        return {
          success: true,
          data: {
            taskCount: backupData.tasks.length,
            imported,
            skipped
          }
        };
      } catch (error) {
        console.error('[TASK_IMPORT] Import failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Import failed'
        };
      }
    }
  );
}
