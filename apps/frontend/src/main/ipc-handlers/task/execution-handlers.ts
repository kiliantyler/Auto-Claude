import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, Subtask } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { rm } from 'fs/promises';
import { spawnSync, execFileSync } from 'child_process';
import { AgentManager } from '../../agent';
import { findTaskAndProject } from './shared';
import { checkGitStatus } from '../../project-initializer';
import { getClaudeProfileManager } from '../../claude-profile-manager';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { getToolPath } from '../../cli-tool-manager';
import { getProjectTaskStorage } from '../../task-storage';
import { taskLogService } from '../../task-log-service';

/**
 * NOTE: Task execution handlers - ALL task data persistence goes through SQLite.
 * JSON files are no longer written or read during runtime.
 * The Python backend reads spec.md and writes QA reports/fix requests (markdown files only).
 */

/**
 * Helper function to check subtask completion status from SQLite task data
 */
function checkSubtasksCompletion(subtasks: Subtask[] | undefined): {
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
} {
  const allSubtasks = subtasks || [];
  const completedCount = allSubtasks.filter(s => s.status === 'completed').length;
  const totalCount = allSubtasks.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  return { completedCount, totalCount, allCompleted };
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Start a task
   */
  ipcMain.on(
    IPC_CHANNELS.TASK_START,
    (_, taskId: string, _options?: TaskStartOptions) => {
      console.warn('[TASK_START] Received request for taskId:', taskId);
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        console.warn('[TASK_START] No main window found');
        return;
      }

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        console.warn('[TASK_START] Task or project not found for taskId:', taskId);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Task or project not found'
        );
        return;
      }

      // Check git status - Auto Claude requires git for worktree-based builds
      const gitStatus = checkGitStatus(project.path);
      if (!gitStatus.isGitRepo) {
        console.warn('[TASK_START] Project is not a git repository:', project.path);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Git repository required. Please run "git init" in your project directory. Auto Claude uses git worktrees for isolated builds.'
        );
        return;
      }
      if (!gitStatus.hasCommits) {
        console.warn('[TASK_START] Git repository has no commits:', project.path);
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").'
        );
        return;
      }

      // Check authentication - Claude requires valid auth to run tasks
      const profileManager = getClaudeProfileManager();
      if (!profileManager.hasValidAuth()) {
        console.warn('[TASK_START] No valid authentication for active profile');
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_ERROR,
          taskId,
          'Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.'
        );
        return;
      }

      console.warn('[TASK_START] Found task:', task.specId, 'status:', task.status, 'subtasks:', task.subtasks.length);

      // Start file watcher for this task
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Check if task uses a worktree - also watch that directory for real-time updates
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath
        ? path.join(worktreePath, specsBaseDir, task.specId)
        : undefined;

      // Check if spec.md exists (indicates spec creation was already done or in progress)
      const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
      const hasSpec = existsSync(specFilePath);

      // Check if this task needs spec creation first (no spec file = not yet created)
      // OR if it has a spec but no implementation plan subtasks (spec created, needs planning/building)
      const needsSpecCreation = !hasSpec;
      const needsImplementation = hasSpec && task.subtasks.length === 0;

      console.warn('[TASK_START] hasSpec:', hasSpec, 'needsSpecCreation:', needsSpecCreation, 'needsImplementation:', needsImplementation);

      // Get base branch: task-level override takes precedence over project settings
      const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;

      if (needsSpecCreation) {
        // No spec file - need to run spec_runner.py to create the spec
        const taskDescription = task.description || task.title;
        console.warn('[TASK_START] Starting spec creation for:', task.specId, 'in:', specDir, 'baseBranch:', baseBranch);

        // Start spec creation process - pass the existing spec directory
        // so spec_runner uses it instead of creating a new one
        // Also pass baseBranch so worktrees are created from the correct branch
        agentManager.startSpecCreation(task.specId, project.path, taskDescription, specDir, task.metadata, baseBranch);
      } else if (needsImplementation) {
        // Spec exists but no subtasks - run run.py to create implementation plan and execute
        // Read the spec.md to get the task description
        const _taskDescription = task.description || task.title;
        try {
          readFileSync(specFilePath, 'utf-8');
        } catch {
          // Use default description
        }

        console.warn('[TASK_START] Starting task execution (no subtasks) for:', task.specId);
        // Start task execution which will create the implementation plan
        // Note: No parallel mode for planning phase - parallel only makes sense with multiple subtasks
        agentManager.startTaskExecution(
          taskId,
          project.path,
          task.specId,
          {
            parallel: false,  // Sequential for planning phase
            workers: 1,
            baseBranch,
            useWorktree: task.metadata?.useWorktree,
            useLocalBranch: project.settings?.useLocalBranch ?? true
          }
        );
      } else {
        // Task has subtasks, start normal execution
        // Note: Parallel execution is handled internally by the agent, not via CLI flags
        console.warn('[TASK_START] Starting task execution (has subtasks) for:', task.specId);

        agentManager.startTaskExecution(
          taskId,
          project.path,
          task.specId,
          {
            parallel: false,
            workers: 1,
            baseBranch,
            useWorktree: task.metadata?.useWorktree,
            useLocalBranch: project.settings?.useLocalBranch ?? true
          }
        );
      }

      // Notify status change IMMEDIATELY (don't wait for file write)
      // This provides instant UI feedback while file persistence happens in background
      const ipcSentAt = Date.now();
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'in_progress'
      );

      const DEBUG = process.env.DEBUG === 'true';
      if (DEBUG) {
        console.log(`[TASK_START] IPC sent immediately for task ${taskId}, deferring file persistence`);
      }

      // Persist status to project-local SQLite database
      // Use task.id (the actual database ID) not taskId (which might be specId)
      setImmediate(() => {
        try {
          const storage = getProjectTaskStorage(project.path);
          storage.updateTask(task.id, { status: 'in_progress' });
          if (DEBUG) {
            console.log(`[TASK_START] Updated task status in database: ${task.id} -> in_progress`);
          }
        } catch (dbErr) {
          console.error('[TASK_START] Failed to update task status in database:', dbErr);
        }
      });
    }
  );

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    const DEBUG = process.env.DEBUG === 'true';

    agentManager.killTask(taskId);

    // Notify status change IMMEDIATELY for instant UI feedback
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'backlog'
      );
    }

    if (DEBUG) {
      console.log(`[TASK_STOP] IPC sent immediately for task ${taskId}, deferring persistence`);
    }

    // Find task and project
    const { task, project } = findTaskAndProject(taskId);

    if (task && project) {
      const worktreePath = findTaskWorktree(project.path, task.specId);

      // Check if task is in early stages (planning phase with no completed coding work)
      // If so, we should clean up the worktree so next start gets fresh repo state
      // Use SQLite task data instead of reading JSON plan files
      const { completedCount } = checkSubtasksCompletion(task.subtasks);
      const hasCompletedCodingWork = completedCount > 0;

      // Also check execution phase - if still in planning/idle, safe to clean up
      const executionPhase = task.executionProgress?.phase;
      const isInPlanningPhase = !executionPhase || executionPhase === 'idle' || executionPhase === 'planning';

      const shouldCleanupWorktree = !hasCompletedCodingWork || isInPlanningPhase;

      if (DEBUG) {
        console.log(`[TASK_STOP] hasCompletedCodingWork=${hasCompletedCodingWork}, executionPhase=${executionPhase}, shouldCleanupWorktree=${shouldCleanupWorktree}`);
      }

      setImmediate(async () => {
        try {
          if (shouldCleanupWorktree && worktreePath) {
            // Clean up worktree for tasks in planning phase
            console.warn(`[TASK_STOP] Task in planning phase, cleaning up worktree: ${worktreePath}`);

            // Get branch name before removing worktree
            let branchName: string | null = null;
            try {
              branchName = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: worktreePath,
                encoding: 'utf-8'
              }).trim();
            } catch {
              // Branch detection failed, not critical
            }

            // Remove the worktree
            try {
              execFileSync(getToolPath('git'), ['worktree', 'remove', '--force', worktreePath], {
                cwd: project.path,
                encoding: 'utf-8'
              });
              console.warn(`[TASK_STOP] Removed git worktree: ${worktreePath}`);

              // Delete the branch if found
              if (branchName && branchName !== 'HEAD' && !branchName.includes('(HEAD detached')) {
                try {
                  execFileSync(getToolPath('git'), ['branch', '-D', branchName], {
                    cwd: project.path,
                    encoding: 'utf-8'
                  });
                  console.warn(`[TASK_STOP] Deleted branch: ${branchName}`);
                } catch {
                  // Branch deletion failed, not critical
                }
              }
            } catch (gitError) {
              // If git worktree remove fails, try manual delete
              console.warn(`[TASK_STOP] Git worktree remove failed, trying manual delete: ${gitError}`);
              try {
                await rm(worktreePath, { recursive: true, force: true });
                execFileSync(getToolPath('git'), ['worktree', 'prune'], {
                  cwd: project.path,
                  encoding: 'utf-8'
                });
              } catch {
                // Manual delete failed, not critical
              }
            }

            // Also clean up the spec directory in main project since it will be recreated on next start
            const specsBaseDir = getSpecsDir(project.autoBuildPath);
            const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
            if (existsSync(mainSpecDir)) {
              try {
                await rm(mainSpecDir, { recursive: true, force: true });
                console.warn(`[TASK_STOP] Cleaned up spec directory: ${mainSpecDir}`);
              } catch {
                // Spec cleanup failed, not critical
              }
            }
          }

          // Update status in project-local SQLite database
          // Use task.id (the actual database ID) not taskId (which might be specId)
          try {
            const storage = getProjectTaskStorage(project.path);
            storage.updateTask(task.id, { status: 'backlog' });
            if (DEBUG) {
              console.log(`[TASK_STOP] Updated task status in database: ${task.id} -> backlog`);
            }
          } catch (dbErr) {
            console.error('[TASK_STOP] Failed to update task status in database:', dbErr);
          }

          // Invalidate cache to refresh task list
          projectStore.invalidateTasksCache(project.id);
        } catch (err) {
          console.error('[TASK_STOP] Failed during stop handler:', err);
        }
      });
    }
  });

  /**
   * Reset a task completely - delete worktree, spec directory, and move to backlog
   * This allows starting fresh with the latest repo state
   */
  ipcMain.handle(IPC_CHANNELS.TASK_RESET, async (_, taskId: string): Promise<IPCResult> => {
    const DEBUG = process.env.DEBUG === 'true';

    // First, stop the task if running
    agentManager.killTask(taskId);

    const { task, project } = findTaskAndProject(taskId);

    if (!task || !project) {
      return { success: false, error: 'Task not found' };
    }

    const worktreePath = findTaskWorktree(project.path, task.specId);
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);

    try {
      // 1. Remove worktree if exists
      if (worktreePath) {
        console.warn(`[TASK_RESET] Removing worktree: ${worktreePath}`);

        // Get branch name before removing
        let branchName: string | null = null;
        try {
          branchName = execFileSync(getToolPath('git'), ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: worktreePath,
            encoding: 'utf-8'
          }).trim();
        } catch {
          // Branch detection failed, not critical
        }

        // Remove the worktree
        try {
          execFileSync(getToolPath('git'), ['worktree', 'remove', '--force', worktreePath], {
            cwd: project.path,
            encoding: 'utf-8'
          });
          console.warn(`[TASK_RESET] Removed git worktree: ${worktreePath}`);

          // Delete the branch if found
          if (branchName && branchName !== 'HEAD' && !branchName.includes('(HEAD detached')) {
            try {
              execFileSync(getToolPath('git'), ['branch', '-D', branchName], {
                cwd: project.path,
                encoding: 'utf-8'
              });
              console.warn(`[TASK_RESET] Deleted branch: ${branchName}`);
            } catch {
              // Branch deletion failed, not critical
            }
          }
        } catch (gitError) {
          // If git worktree remove fails, try manual delete
          console.warn(`[TASK_RESET] Git worktree remove failed, trying manual delete: ${gitError}`);
          try {
            await rm(worktreePath, { recursive: true, force: true });
            execFileSync(getToolPath('git'), ['worktree', 'prune'], {
              cwd: project.path,
              encoding: 'utf-8'
            });
            console.warn(`[TASK_RESET] Manually deleted worktree directory`);
          } catch (rmError) {
            console.error(`[TASK_RESET] Failed to manually delete worktree: ${rmError}`);
          }
        }
      }

      // 2. Delete execution artifacts in spec directory, but KEEP spec.md (the task definition)
      // Files to delete: implementation_plan.json, qa_report.md, QA_FIX_REQUEST.md, memory/, graphiti/
      // Files to keep: spec.md (task definition), requirements.json, context.json
      if (existsSync(mainSpecDir)) {
        console.warn(`[TASK_RESET] Cleaning execution artifacts in: ${mainSpecDir}`);

        const filesToDelete = [
          'implementation_plan.json',
          'qa_report.md',
          'QA_FIX_REQUEST.md'
        ];

        const dirsToDelete = [
          'memory',
          'graphiti'
        ];

        // Delete specific files
        for (const file of filesToDelete) {
          const filePath = path.join(mainSpecDir, file);
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath);
              console.warn(`[TASK_RESET] Deleted: ${file}`);
            } catch {
              console.warn(`[TASK_RESET] Could not delete: ${file}`);
            }
          }
        }

        // Delete directories
        for (const dir of dirsToDelete) {
          const dirPath = path.join(mainSpecDir, dir);
          if (existsSync(dirPath)) {
            try {
              await rm(dirPath, { recursive: true, force: true });
              console.warn(`[TASK_RESET] Deleted directory: ${dir}`);
            } catch {
              console.warn(`[TASK_RESET] Could not delete directory: ${dir}`);
            }
          }
        }

        console.warn(`[TASK_RESET] Cleaned execution artifacts (kept spec.md)`);
      }

      // 3. Update task status to backlog and reset subtasks/executionProgress
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          'backlog'
        );
      }

      // Update status in project-local SQLite database
      // Use task.id (the actual database ID) not taskId (which might be specId)
      // Clear subtasks entirely (not just reset to pending) so the task starts fresh
      // This is necessary because we deleted implementation_plan.json from disk
      try {
        const storage = getProjectTaskStorage(project.path);

        storage.updateTask(task.id, {
          status: 'backlog',
          subtasks: [],  // Clear subtasks - they'll be recreated when run.py generates new plan
          executionProgress: undefined,
          qaReport: undefined,  // Clear QA report too
        });

        // Clear task logs from SQLite so the logs page shows fresh logs on next run
        storage.clearTaskLogs(task.id);

        // Also clear the in-memory log cache in TaskLogService
        taskLogService.clearCache(mainSpecDir);
        taskLogService.stopWatching(task.specId);

        if (DEBUG) {
          console.log(`[TASK_RESET] Updated task in database: ${task.id} -> backlog, cleared subtasks, QA report, and logs`);
        }
      } catch (dbErr) {
        console.error('[TASK_RESET] Failed to update task status in database:', dbErr);
      }

      // 4. Clear execution progress
      if (mainWindow) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_EXECUTION_PROGRESS,
          taskId,
          { phase: 'idle', message: 'Task reset' },
          project.id
        );
      }

      // 5. Invalidate project store cache to force refresh
      projectStore.invalidateTasksCache(project.id);

      if (DEBUG) {
        console.log(`[TASK_RESET] Task ${taskId} reset successfully`);
      }

      return { success: true };
    } catch (error) {
      console.error(`[TASK_RESET] Failed to reset task:`, error);
      return { success: false, error: `Failed to reset task: ${error}` };
    }
  });

  /**
   * Review a task (approve or reject)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string
    ): Promise<IPCResult> => {
      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Check if dev mode is enabled for this project
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(
        project.path,
        specsBaseDir,
        task.specId
      );

      // Check if worktree exists - QA needs to run in the worktree where the build happened
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;
      const hasWorktree = worktreePath !== null;

      if (approved) {
        // Write approval to QA report
        const qaReportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
        try {
          writeFileSync(
            qaReportPath,
            `# QA Review\n\nStatus: APPROVED\n\nReviewed at: ${new Date().toISOString()}\n`
          );
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to write QA report:', error);
          return { success: false, error: 'Failed to write QA report file' };
        }

        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            'done'
          );
        }

        // Update status in project-local SQLite database
        // Use task.id (the actual database ID) not taskId (which might be specId)
        try {
          const storage = getProjectTaskStorage(project.path);
          storage.updateTask(task.id, { status: 'done' });
          console.debug(`[TASK_REVIEW] Updated task status in database: ${task.id} -> done`);
        } catch (dbErr) {
          console.error('[TASK_REVIEW] Failed to update task status in database:', dbErr);
        }
      } else {
        // Reset and discard all changes from worktree merge in main
        // The worktree still has all changes, so nothing is lost
        if (hasWorktree) {
          // Step 1: Unstage all changes
          const resetResult = spawnSync('git', ['reset', 'HEAD'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          if (resetResult.status === 0) {
            console.log('[TASK_REVIEW] Unstaged changes in main');
          }

          // Step 2: Discard all working tree changes (restore to pre-merge state)
          const checkoutResult = spawnSync('git', ['checkout', '--', '.'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          if (checkoutResult.status === 0) {
            console.log('[TASK_REVIEW] Discarded working tree changes in main');
          }

          // Step 3: Clean untracked files that came from the merge
          // IMPORTANT: Exclude .auto-claude directory to preserve specs and worktree data
          const cleanResult = spawnSync('git', ['clean', '-fd', '-e', '.auto-claude'], {
            cwd: project.path,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          if (cleanResult.status === 0) {
            console.log('[TASK_REVIEW] Cleaned untracked files in main (excluding .auto-claude)');
          }

          console.log('[TASK_REVIEW] Main branch restored to pre-merge state');
        }

        // Write feedback for QA fixer - write to WORKTREE spec dir if it exists
        // The QA process runs in the worktree where the build and implementation_plan.json are
        const targetSpecDir = hasWorktree && worktreeSpecDir ? worktreeSpecDir : specDir;
        const fixRequestPath = path.join(targetSpecDir, 'QA_FIX_REQUEST.md');

        console.warn('[TASK_REVIEW] Writing QA fix request to:', fixRequestPath);
        console.warn('[TASK_REVIEW] hasWorktree:', hasWorktree, 'worktreePath:', worktreePath);

        try {
          writeFileSync(
            fixRequestPath,
            `# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\n${feedback || 'No feedback provided'}\n\nCreated at: ${new Date().toISOString()}\n`
          );
        } catch (error) {
          console.error('[TASK_REVIEW] Failed to write QA fix request:', error);
          return { success: false, error: 'Failed to write QA fix request file' };
        }

        // Restart QA process - use worktree path if it exists, otherwise main project
        // The QA process needs to run where the implementation_plan.json with completed subtasks is
        const qaProjectPath = hasWorktree ? worktreePath : project.path;
        console.warn('[TASK_REVIEW] Starting QA process with projectPath:', qaProjectPath);
        agentManager.startQAProcess(taskId, qaProjectPath, task.specId);

        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            'in_progress'
          );
        }

        // Update status in project-local SQLite database
        // Use task.id (the actual database ID) not taskId (which might be specId)
        try {
          const storage = getProjectTaskStorage(project.path);
          storage.updateTask(task.id, { status: 'in_progress' });
          console.debug(`[TASK_REVIEW] Updated task status in database: ${task.id} -> in_progress`);
        } catch (dbErr) {
          console.error('[TASK_REVIEW] Failed to update task status in database:', dbErr);
        }
      }

      return { success: true };
    }
  );

  /**
   * Update task status manually
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus
    ): Promise<IPCResult> => {
      // Find task and project first (needed for worktree check)
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Validate status transition - 'done' can only be set through merge handler
      // UNLESS there's no worktree (limbo state - already merged/discarded or failed)
      if (status === 'done') {
        // Check if worktree exists (task.specId matches worktree folder name)
        const worktreePath = findTaskWorktree(project.path, task.specId);
        const hasWorktree = worktreePath !== null;

        if (hasWorktree) {
          // Worktree exists - must use merge workflow
          console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'done' directly for task ${taskId}. Use merge workflow instead.`);
          return {
            success: false,
            error: "Cannot set status to 'done' directly. Complete the human review and merge the worktree changes instead."
          };
        } else {
          // No worktree - allow marking as done (limbo state recovery)
          console.log(`[TASK_UPDATE_STATUS] Allowing status 'done' for task ${taskId} (no worktree found - limbo state)`);
        }
      }

      // Validate status transition - 'human_review' requires actual work to have been done
      // This prevents tasks from being incorrectly marked as ready for review when execution failed
      if (status === 'human_review') {
        const specsBaseDirForValidation = getSpecsDir(project.autoBuildPath);
        const specDirForValidation = path.join(
          project.path,
          specsBaseDirForValidation,
          task.specId
        );
        const specFilePath = path.join(specDirForValidation, AUTO_BUILD_PATHS.SPEC_FILE);

        // Check if spec.md exists and has meaningful content (at least 100 chars)
        const MIN_SPEC_CONTENT_LENGTH = 100;
        let specContent = '';
        try {
          if (existsSync(specFilePath)) {
            specContent = readFileSync(specFilePath, 'utf-8');
          }
        } catch {
          // Ignore read errors - treat as empty spec
        }

        if (!specContent || specContent.length < MIN_SPEC_CONTENT_LENGTH) {
          console.warn(`[TASK_UPDATE_STATUS] Blocked attempt to set status 'human_review' for task ${taskId}. No spec has been created yet.`);
          return {
            success: false,
            error: "Cannot move to human review - no spec has been created yet. The task must complete processing before review."
          };
        }
      }

      // Get the spec directory
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(project.path, specsBaseDir, task.specId);

      try {
        // Auto-stop task when status changes AWAY from 'in_progress' and process IS running
        // This handles the case where user drags a running task back to Planning/backlog
        if (status !== 'in_progress' && agentManager.isRunning(taskId)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          agentManager.killTask(taskId);
        }

        // Auto-start task when status changes to 'in_progress' and no process is running
        if (status === 'in_progress' && !agentManager.isRunning(taskId)) {
          const mainWindow = getMainWindow();

          // Check git status before auto-starting
          const gitStatusCheck = checkGitStatus(project.path);
          if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
            console.warn('[TASK_UPDATE_STATUS] Git check failed, cannot auto-start task');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                gitStatusCheck.error || 'Git repository with commits required to run tasks.'
              );
            }
            return { success: false, error: gitStatusCheck.error || 'Git repository required' };
          }

          // Check authentication before auto-starting
          const profileManager = getClaudeProfileManager();
          if (!profileManager.hasValidAuth()) {
            console.warn('[TASK_UPDATE_STATUS] No valid authentication for active profile');
            if (mainWindow) {
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_ERROR,
                taskId,
                'Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account, or set an OAuth token.'
              );
            }
            return { success: false, error: 'Claude authentication required' };
          }

          console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);

          // Start file watcher for this task
          // Also watch worktree directory for real-time updates
          const worktreePathForUpdate = findTaskWorktree(project.path, task.specId);
          const worktreeSpecDirForUpdate = worktreePathForUpdate
            ? path.join(worktreePathForUpdate, specsBaseDir, task.specId)
            : undefined;

          // Check if spec.md exists
          const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
          const hasSpec = existsSync(specFilePath);
          const needsSpecCreation = !hasSpec;
          const needsImplementation = hasSpec && task.subtasks.length === 0;

          console.warn('[TASK_UPDATE_STATUS] hasSpec:', hasSpec, 'needsSpecCreation:', needsSpecCreation, 'needsImplementation:', needsImplementation);

          // Get base branch: task-level override takes precedence over project settings
          const baseBranchForUpdate = task.metadata?.baseBranch || project.settings?.mainBranch;

          if (needsSpecCreation) {
            // No spec file - need to run spec_runner.py to create the spec
            const taskDescription = task.description || task.title;
            console.warn('[TASK_UPDATE_STATUS] Starting spec creation for:', task.specId);
            agentManager.startSpecCreation(task.specId, project.path, taskDescription, specDir, task.metadata, baseBranchForUpdate);
          } else if (needsImplementation) {
            // Spec exists but no subtasks - run run.py to create implementation plan and execute
            console.warn('[TASK_UPDATE_STATUS] Starting task execution (no subtasks) for:', task.specId);
            agentManager.startTaskExecution(
              taskId,
              project.path,
              task.specId,
              {
                parallel: false,
                workers: 1,
                baseBranch: baseBranchForUpdate,
                useWorktree: task.metadata?.useWorktree,
                useLocalBranch: project.settings?.useLocalBranch ?? true
              }
            );
          } else {
            // Task has subtasks, start normal execution
            // Note: Parallel execution is handled internally by the agent
            console.warn('[TASK_UPDATE_STATUS] Starting task execution (has subtasks) for:', task.specId);
            agentManager.startTaskExecution(
              taskId,
              project.path,
              task.specId,
              {
                parallel: false,
                workers: 1,
                baseBranch: baseBranchForUpdate,
                useWorktree: task.metadata?.useWorktree,
                useLocalBranch: project.settings?.useLocalBranch ?? true
              }
            );
          }

          // Notify renderer about status change
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.TASK_STATUS_CHANGE,
              taskId,
              'in_progress'
            );
          }
        }

        // Update status in project-local SQLite database
        // Use task.id (the actual database ID) not taskId (which might be specId)
        try {
          const storage = getProjectTaskStorage(project.path);
          storage.updateTask(task.id, { status });
          projectStore.invalidateTasksCache(project.id);
          console.debug(`[TASK_UPDATE_STATUS] Updated task status in database: ${task.id} -> ${status}`);
        } catch (dbErr) {
          console.error('[TASK_UPDATE_STATUS] Failed to update task status in database:', dbErr);
          return { success: false, error: 'Failed to update task status in database' };
        }

        return { success: true };
      } catch (error) {
        console.error('Failed to update task status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task status'
        };
      }
    }
  );

  /**
   * Check if a task is actually running (has active process)
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string): Promise<IPCResult<boolean>> => {
      const isRunning = agentManager.isRunning(taskId);
      return { success: true, data: isRunning };
    }
  );

  /**
   * Recover a stuck task (status says in_progress but no process running)
   *
   * NOTE: Uses SQLite as the source of truth for task/subtask state.
   * Attempt history files (memory/attempt_history.json) are managed by Python backend.
   */
  ipcMain.handle(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    async (
      _,
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean }
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const targetStatus = options?.targetStatus;
      const autoRestart = options?.autoRestart ?? false;

      // Check if task is actually running
      const isActuallyRunning = agentManager.isRunning(taskId);

      if (isActuallyRunning) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: {
            taskId,
            recovered: false,
            newStatus: 'in_progress' as TaskStatus,
            message: 'Task is still running'
          }
        };
      }

      // Find task and project
      const { task, project } = findTaskAndProject(taskId);

      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      try {
        // Determine the target status intelligently based on subtask progress from SQLite
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks
        let newStatus: TaskStatus = targetStatus || 'backlog';

        if (!targetStatus) {
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(task.subtasks);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review
              // For recovery, human_review is safer as it requires manual verification
              newStatus = 'human_review';
            } else if (completedCount > 0) {
              // Some subtasks completed, some still pending - task is in progress
              newStatus = 'in_progress';
            }
            // else: no subtasks completed, stay with 'backlog'
          }
        }

        // Check if task is fully complete (all subtasks done)
        const { allCompleted } = checkSubtasksCompletion(task.subtasks);

        if (allCompleted && task.subtasks && task.subtasks.length > 0) {
          console.log('[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart');

          // Update status in project-local SQLite
          const storage = getProjectTaskStorage(project.path);
          storage.updateTask(task.id, { status: 'human_review' });
          projectStore.invalidateTasksCache(project.id);

          // Notify renderer
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send(
              IPC_CHANNELS.TASK_STATUS_CHANGE,
              taskId,
              'human_review'
            );
          }

          return {
            success: true,
            data: {
              taskId,
              recovered: true,
              newStatus: 'human_review',
              message: 'Task is complete and ready for review',
              autoRestarted: false
            }
          };
        }

        // Task is not complete - reset stuck/failed subtasks in SQLite
        const resetSubtaskIds: string[] = [];
        const updatedSubtasks: Subtask[] = (task.subtasks || []).map(subtask => {
          if (subtask.status === 'in_progress' || subtask.status === 'failed') {
            console.log(`[Recovery] Reset subtask ${subtask.id}: ${subtask.status} -> pending`);
            resetSubtaskIds.push(subtask.id);
            return { ...subtask, status: 'pending' as const };
          }
          return subtask;
        });

        console.log(`[Recovery] Subtasks reset: ${resetSubtaskIds.length}`, resetSubtaskIds);

        // Update subtasks in project-local SQLite
        const storage = getProjectTaskStorage(project.path);
        storage.updateTask(task.id, {
          status: newStatus,
          subtasks: updatedSubtasks
        });
        projectStore.invalidateTasksCache(project.id);

        // Auto-restart the task if requested
        let autoRestarted = false;
        if (autoRestart && project) {
          // Check git status before auto-restarting
          const gitStatusForRestart = checkGitStatus(project.path);
          if (!gitStatusForRestart.isGitRepo || !gitStatusForRestart.hasCommits) {
            console.warn('[Recovery] Git check failed, cannot auto-restart task');
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: `Task recovered but cannot restart: ${gitStatusForRestart.error || 'Git repository with commits required.'}`,
                autoRestarted: false
              }
            };
          }

          // Check authentication before auto-restarting
          const profileManager = getClaudeProfileManager();
          if (!profileManager.hasValidAuth()) {
            console.warn('[Recovery] Auth check failed, cannot auto-restart task');
            return {
              success: true,
              data: {
                taskId,
                recovered: true,
                newStatus,
                message: 'Task recovered but cannot restart: Claude authentication required. Please go to Settings > Claude Profiles and authenticate your account.',
                autoRestarted: false
              }
            };
          }

          try {
            // Set status to in_progress for the restart
            newStatus = 'in_progress';
            storage.updateTask(task.id, { status: 'in_progress' });

            // Start the task execution
            const specsBaseDir = getSpecsDir(project.autoBuildPath);
            const specDirForRecovery = path.join(project.path, specsBaseDir, task.specId);

            // Check if spec.md exists to determine whether to run spec creation or task execution
            const specFilePath = path.join(specDirForRecovery, AUTO_BUILD_PATHS.SPEC_FILE);
            const hasSpec = existsSync(specFilePath);
            const needsSpecCreation = !hasSpec;

            // Get base branch: task-level override takes precedence over project settings
            const baseBranchForRecovery = task.metadata?.baseBranch || project.settings?.mainBranch;

            if (needsSpecCreation) {
              const taskDescription = task.description || task.title;
              console.warn(`[Recovery] Starting spec creation for: ${task.specId}`);
              agentManager.startSpecCreation(task.specId, project.path, taskDescription, specDirForRecovery, task.metadata, baseBranchForRecovery);
            } else {
              console.warn(`[Recovery] Starting task execution for: ${task.specId}`);
              agentManager.startTaskExecution(
                taskId,
                project.path,
                task.specId,
                {
                  parallel: false,
                  workers: 1,
                  baseBranch: baseBranchForRecovery,
                  useWorktree: task.metadata?.useWorktree,
                  useLocalBranch: project.settings?.useLocalBranch ?? true
                }
              );
            }

            autoRestarted = true;
            console.warn(`[Recovery] Auto-restarted task ${taskId}`);
          } catch (restartError) {
            console.error('Failed to auto-restart task after recovery:', restartError);
            // Recovery succeeded but restart failed - still report success
          }
        }

        // Notify renderer of status change
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(
            IPC_CHANNELS.TASK_STATUS_CHANGE,
            taskId,
            newStatus
          );
        }

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    }
  );
}
