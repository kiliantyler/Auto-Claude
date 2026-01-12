import { ipcMain } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, Task, TaskMetadata } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { projectStore } from '../../project-store';
import { titleGenerator } from '../../title-generator';
import { AgentManager } from '../../agent';
import { findTaskAndProject } from './shared';
import { findTaskWorktree } from '../../worktree-paths';
import { getToolPath } from '../../cli-tool-manager';
import { getProjectTaskStorage } from '../../task-storage';

/**
 * Register task CRUD (Create, Read, Update, Delete) handlers
 */
export function registerTaskCRUDHandlers(agentManager: AgentManager): void {
  console.log('[CRUD Handlers] Initialized (SQLite-only mode)');

  /**
   * List all tasks for a project
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async (_, projectId: string): Promise<IPCResult<Task[]>> => {
      console.warn('[IPC] TASK_LIST called with projectId:', projectId);
      const tasks = projectStore.getTasks(projectId);
      console.warn('[IPC] TASK_LIST returning', tasks.length, 'tasks');

      // Database event poller now handles real-time updates automatically
      // No need to manually start file watchers - database triggers emit IPC events

      return { success: true, data: tasks };
    }
  );

  /**
   * Create a new task
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CREATE,
    async (
      _,
      projectId: string,
      title: string,
      description: string,
      metadata?: TaskMetadata
    ): Promise<IPCResult<Task>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Auto-generate title if empty using Claude AI
      let finalTitle = title;
      if (!title || !title.trim()) {
        console.warn('[TASK_CREATE] Title is empty, generating with Claude AI...');
        try {
          const generatedTitle = await titleGenerator.generateTitle(description);
          if (generatedTitle) {
            finalTitle = generatedTitle;
            console.warn('[TASK_CREATE] Generated title:', finalTitle);
          } else {
            // Fallback: create title from first line of description
            finalTitle = description.split('\n')[0].substring(0, 60);
            if (finalTitle.length === 60) finalTitle += '...';
            console.warn('[TASK_CREATE] AI generation failed, using fallback:', finalTitle);
          }
        } catch (err) {
          console.error('[TASK_CREATE] Title generation error:', err);
          // Fallback: create title from first line of description
          finalTitle = description.split('\n')[0].substring(0, 60);
          if (finalTitle.length === 60) finalTitle += '...';
        }
      }

      // Generate a unique spec ID based on existing specs
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specsDir = path.join(project.path, specsBaseDir);

      // Find next available spec number
      let specNumber = 1;
      if (existsSync(specsDir)) {
        const existingDirs = readdirSync(specsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        // Extract numbers from spec directory names (e.g., "001-feature" -> 1)
        const existingNumbers = existingDirs
          .map(name => {
            const match = name.match(/^(\d+)/);
            return match ? parseInt(match[1], 10) : 0;
          })
          .filter(n => n > 0);

        if (existingNumbers.length > 0) {
          specNumber = Math.max(...existingNumbers) + 1;
        }
      }

      // Create spec ID with zero-padded number and slugified title
      const slugifiedTitle = finalTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);
      const specId = `${String(specNumber).padStart(3, '0')}-${slugifiedTitle}`;

      // Create spec directory (always needed for worktree structure)
      const specDir = path.join(specsDir, specId);
      mkdirSync(specDir, { recursive: true });

      // Build metadata with source type
      const taskMetadata: TaskMetadata = {
        sourceType: 'manual',
        ...metadata
      };

      // Process and save attached images to filesystem
      if (taskMetadata.attachedImages && taskMetadata.attachedImages.length > 0) {
        const attachmentsDir = path.join(specDir, 'attachments');
        mkdirSync(attachmentsDir, { recursive: true });

        const savedImages: typeof taskMetadata.attachedImages = [];

        for (const image of taskMetadata.attachedImages) {
          if (image.data) {
            try {
              // Decode base64 and save to file
              const buffer = Buffer.from(image.data, 'base64');
              const imagePath = path.join(attachmentsDir, image.filename);
              writeFileSync(imagePath, buffer);

              // Store relative path instead of base64 data
              savedImages.push({
                id: image.id,
                filename: image.filename,
                mimeType: image.mimeType,
                size: image.size,
                path: `attachments/${image.filename}`
                // Don't include data or thumbnail to save space
              });
            } catch (err) {
              console.error(`Failed to save image ${image.filename}:`, err);
            }
          }
        }

        // Update metadata with saved image paths (without base64 data)
        taskMetadata.attachedImages = savedImages;
      }

      // Create the task object
      const task: Task = {
        id: specId,
        specId: specId,
        projectId,
        title: finalTitle,
        description,
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata: taskMetadata,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Write to project-local SQLite database
      try {
        const taskStorage = getProjectTaskStorage(project.path);
        taskStorage.createTask(task);
        console.warn(`[TASK_CREATE] Written to project-local database: ${task.id}`);
      } catch (dbError) {
        console.error('[TASK_CREATE] Failed to write to SQLite:', dbError);
        return {
          success: false,
          error: dbError instanceof Error ? dbError.message : 'Failed to create task in database'
        };
      }

      // Invalidate cache since a new task was created
      projectStore.invalidateTasksCache(projectId);

      return { success: true, data: task };
    }
  );

  /**
   * Delete a task
   * This fully cleans up all task-related resources:
   * - Stops the file watcher
   * - Removes the worktree (if exists)
   * - Deletes the associated git branch
   * - Deletes spec directories in both main project and worktree
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_DELETE,
    async (_, taskId: string): Promise<IPCResult> => {
      const { rm } = await import('fs/promises');

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task or project not found' };
      }

      // Check if task is currently running
      const isRunning = agentManager.isRunning(taskId);
      if (isRunning) {
        return { success: false, error: 'Cannot delete a running task. Stop the task first.' };
      }

      try {
        // Database event poller handles events automatically - no manual cleanup needed

        // 1. Find and remove worktree if it exists
        // First try the standard path lookup
        let worktreePath = findTaskWorktree(project.path, task.specId);
        let branchName: string | null = null;

        // If not found by path, search git worktree list for matching branch
        if (!worktreePath) {
          console.warn(`[TASK_DELETE] No worktree found by path for specId: ${task.specId}, checking git worktree list...`);
          try {
            const worktreeList = execFileSync(getToolPath('git'), ['worktree', 'list', '--porcelain'], {
              cwd: project.path,
              encoding: 'utf-8'
            });

            // Parse worktree list to find one matching this task's spec
            // Format: worktree /path\nHEAD abc123\nbranch refs/heads/auto-claude/spec-name\n\n
            const entries = worktreeList.split('\n\n').filter(Boolean);
            for (const entry of entries) {
              const lines = entry.split('\n');
              const worktreeLine = lines.find(l => l.startsWith('worktree '));
              const branchLine = lines.find(l => l.startsWith('branch '));

              if (branchLine && branchLine.includes(task.specId)) {
                worktreePath = worktreeLine?.replace('worktree ', '') || null;
                branchName = branchLine.replace('branch refs/heads/', '');
                console.warn(`[TASK_DELETE] Found worktree via git list: ${worktreePath}, branch: ${branchName}`);
                break;
              }
            }
          } catch (listError) {
            console.warn(`[TASK_DELETE] Failed to list worktrees: ${listError}`);
          }
        }

        if (worktreePath) {
          console.warn(`[TASK_DELETE] Found worktree at: ${worktreePath}`);

          try {
            // Get the branch name before removing worktree (if not already found)
            if (!branchName) {
              try {
                branchName = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
                  cwd: worktreePath,
                  encoding: 'utf-8'
                }).trim();
                console.warn(`[TASK_DELETE] Detected branch: ${branchName}`);
              } catch (branchError) {
                console.warn(`[TASK_DELETE] Branch detection failed: ${branchError}`);
              }
            }

            // Remove the worktree using git
            console.warn(`[TASK_DELETE] Running: git worktree remove --force "${worktreePath}"`);
            execFileSync(getToolPath('git'), ['worktree', 'remove', '--force', worktreePath], {
              cwd: project.path,
              encoding: 'utf-8'
            });
            console.warn(`[TASK_DELETE] Removed git worktree: ${worktreePath}`);

            // Delete the branch if we found one
            if (branchName && branchName !== 'HEAD' && !branchName.includes('(HEAD detached')) {
              try {
                console.warn(`[TASK_DELETE] Running: git branch -D "${branchName}"`);
                execFileSync(getToolPath('git'), ['branch', '-D', branchName], {
                  cwd: project.path,
                  encoding: 'utf-8'
                });
                console.warn(`[TASK_DELETE] Deleted branch: ${branchName}`);
              } catch (branchDeleteError) {
                // Branch might already be deleted or protected
                console.warn(`[TASK_DELETE] Could not delete branch "${branchName}": ${branchDeleteError}`);
              }
            }
          } catch (gitError) {
            // If git worktree remove fails, try to delete the directory manually
            console.error(`[TASK_DELETE] Git worktree remove failed: ${gitError}`);
            try {
              await rm(worktreePath, { recursive: true, force: true });
              console.warn(`[TASK_DELETE] Manually deleted worktree directory: ${worktreePath}`);

              // Also try to prune worktrees after manual delete
              try {
                execFileSync(getToolPath('git'), ['worktree', 'prune'], {
                  cwd: project.path,
                  encoding: 'utf-8'
                });
                console.warn(`[TASK_DELETE] Pruned stale worktrees`);
              } catch {
                // Prune failure is not critical
              }
            } catch (rmError) {
              console.error(`[TASK_DELETE] Failed to manually delete worktree: ${rmError}`);
            }
          }
        } else {
          console.warn(`[TASK_DELETE] No worktree found for task: ${task.specId}`);
        }

        // 3. Also try to delete any orphaned branch matching auto-claude/{specId}
        if (!branchName) {
          const expectedBranchName = `auto-claude/${task.specId}`;
          try {
            execFileSync(getToolPath('git'), ['branch', '-D', expectedBranchName], {
              cwd: project.path,
              encoding: 'utf-8'
            });
            console.warn(`[TASK_DELETE] Deleted orphaned branch: ${expectedBranchName}`);
          } catch {
            // Branch doesn't exist, that's fine
          }
        }

        // 4. Delete the spec directory in the main project
        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);

        console.warn(`[TASK_DELETE] Attempting to delete main spec dir: ${mainSpecDir}`);
        if (existsSync(mainSpecDir)) {
          await rm(mainSpecDir, { recursive: true, force: true });
          console.warn(`[TASK_DELETE] Deleted main spec directory: ${mainSpecDir}`);
        } else {
          console.warn(`[TASK_DELETE] Main spec directory not found: ${mainSpecDir}`);
        }

        // 5. Also try to delete using task.specsPath if different (handles edge cases)
        if (task.specsPath && task.specsPath !== mainSpecDir && existsSync(task.specsPath)) {
          await rm(task.specsPath, { recursive: true, force: true });
          console.warn(`[TASK_DELETE] Deleted additional spec path: ${task.specsPath}`);
        }

        // Delete from project-local SQLite database
        // Use task.id (the actual database ID) not taskId (which might be specId)
        try {
          const taskStorage = getProjectTaskStorage(project.path);
          taskStorage.deleteTask(task.id);
          console.warn(`[TASK_DELETE] Deleted from project-local database: ${task.id}`);
        } catch (dbError) {
          console.error('[TASK_DELETE] Failed to delete from SQLite (continuing):', dbError);
          // Continue - JSON files are already deleted
        }

        // 7. Invalidate cache since a task was deleted
        projectStore.invalidateTasksCache(project.id);

        return { success: true };
      } catch (error) {
        console.error('[TASK_DELETE] Error deleting task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete task files'
        };
      }
    }
  );

  /**
   * Update a task
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE,
    async (
      _,
      taskId: string,
      updates: { title?: string; description?: string; metadata?: Partial<TaskMetadata> }
    ): Promise<IPCResult<Task>> => {
      try {
        // Find task and project
        const { task, project } = findTaskAndProject(taskId);

        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        const autoBuildDir = project.autoBuildPath || '.auto-claude';
        const specDir = path.join(project.path, autoBuildDir, 'specs', task.specId);

        // Auto-generate title if empty
        let finalTitle = updates.title;
        if (updates.title !== undefined && !updates.title.trim()) {
          // Get description to use for title generation
          const descriptionToUse = updates.description ?? task.description;
          console.warn('[TASK_UPDATE] Title is empty, generating with Claude AI...');
          try {
            const generatedTitle = await titleGenerator.generateTitle(descriptionToUse);
            if (generatedTitle) {
              finalTitle = generatedTitle;
              console.warn('[TASK_UPDATE] Generated title:', finalTitle);
            } else {
              // Fallback: create title from first line of description
              finalTitle = descriptionToUse.split('\n')[0].substring(0, 60);
              if (finalTitle.length === 60) finalTitle += '...';
              console.warn('[TASK_UPDATE] AI generation failed, using fallback:', finalTitle);
            }
          } catch (err) {
            console.error('[TASK_UPDATE] Title generation error:', err);
            // Fallback: create title from first line of description
            finalTitle = descriptionToUse.split('\n')[0].substring(0, 60);
            if (finalTitle.length === 60) finalTitle += '...';
          }
        }

        // Update metadata if provided
        let updatedMetadata = task.metadata;
        if (updates.metadata) {
          updatedMetadata = { ...task.metadata, ...updates.metadata };

          // Process and save attached images to filesystem
          if (updates.metadata.attachedImages && updates.metadata.attachedImages.length > 0) {
            const attachmentsDir = path.join(specDir, 'attachments');
            mkdirSync(attachmentsDir, { recursive: true });

            const savedImages: typeof updates.metadata.attachedImages = [];

            for (const image of updates.metadata.attachedImages) {
              // If image has data (new image), save it
              if (image.data) {
                try {
                  const buffer = Buffer.from(image.data, 'base64');
                  const imagePath = path.join(attachmentsDir, image.filename);
                  writeFileSync(imagePath, buffer);

                  savedImages.push({
                    id: image.id,
                    filename: image.filename,
                    mimeType: image.mimeType,
                    size: image.size,
                    path: `attachments/${image.filename}`
                  });
                } catch (err) {
                  console.error(`Failed to save image ${image.filename}:`, err);
                }
              } else if (image.path) {
                // Existing image, keep it
                savedImages.push(image);
              }
            }

            updatedMetadata.attachedImages = savedImages;
          }
        }

        // Build the updated task object
        const updatedTask: Task = {
          ...task,
          title: finalTitle ?? task.title,
          description: updates.description ?? task.description,
          metadata: updatedMetadata,
          updatedAt: new Date()
        };

        // Write to project-local SQLite database
        // Use task.id (the actual database ID) not taskId (which might be specId)
        try {
          const taskStorage = getProjectTaskStorage(project.path);
          taskStorage.updateTask(task.id, {
            title: finalTitle,
            description: updates.description,
            metadata: updatedMetadata
          });
          console.warn(`[TASK_UPDATE] Updated in project-local database: ${task.id}`);
        } catch (dbError) {
          console.error('[TASK_UPDATE] Failed to update in SQLite:', dbError);
          return {
            success: false,
            error: dbError instanceof Error ? dbError.message : 'Failed to update task in database'
          };
        }

        // Invalidate cache since a task was updated
        projectStore.invalidateTasksCache(project.id);

        return { success: true, data: updatedTask };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
  );
}
