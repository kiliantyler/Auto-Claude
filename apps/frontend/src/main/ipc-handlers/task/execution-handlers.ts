import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { rm } from 'fs/promises';
import { spawnSync, execFileSync } from 'child_process';
import { AgentManager } from '../../agent';
import { findTaskAndProject } from './shared';
import { checkGitStatus } from '../../project-initializer';
import { getClaudeProfileManager } from '../../claude-profile-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists
} from './plan-file-utils';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { getToolPath } from '../../cli-tool-manager';
import { getTaskStorage } from '../../task-storage';

/**
 * Atomic file write to prevent TOCTOU race conditions.
 * Writes to a temporary file first, then atomically renames to target.
 * This ensures the target file is never in an inconsistent state.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file if rename failed
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Safe file read that handles missing files without TOCTOU issues.
 * Returns null if file doesn't exist or can't be read.
 */
function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    // ENOENT (file not found) is expected, other errors should be logged
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[safeReadFileSync] Error reading ${filePath}:`, error);
    }
    return null;
  }
}

/**
 * Helper function to check subtask completion status
 */
function checkSubtasksCompletion(plan: Record<string, unknown> | null): {
  allSubtasks: Array<{ status: string }>;
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
} {
  const allSubtasks = (plan?.phases as Array<{ subtasks?: Array<{ status: string }> }> | undefined)?.flatMap(phase =>
    phase.subtasks || []
  ) || [];
  const completedCount = allSubtasks.filter(s => s.status === 'completed').length;
  const totalCount = allSubtasks.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  return { allSubtasks, completedCount, totalCount, allCompleted };
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

      // CRITICAL: Persist status to implementation_plan.json to prevent status flip-flop
      // When getTasks() is called (on refresh), it reads status from the plan file.
      // Without persisting here, the old status (e.g., 'human_review') would override
      // the in-memory 'in_progress' status, causing the task to flip back and forth.
      // Uses shared utility for consistency with agent-events-handlers.ts
      // NOTE: This is now async and non-blocking for better UI responsiveness
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      setImmediate(async () => {
        const persistStart = Date.now();
        try {
          const persisted = await persistPlanStatus(planPath, 'in_progress', project.id);
          if (persisted) {
            console.warn('[TASK_START] Updated plan status to: in_progress');
          }
          if (DEBUG) {
            const delay = persistStart - ipcSentAt;
            const duration = Date.now() - persistStart;
            console.log(`[TASK_START] File persistence: delayed ${delay}ms after IPC, completed in ${duration}ms`);
          }
        } catch (err) {
          console.error('[TASK_START] Failed to persist plan status:', err);
        }

        // Dual-write: Update status in SQLite database
        try {
          const storage = getTaskStorage();
          storage.updateTask(taskId, { status: 'in_progress' });
          if (DEBUG) {
            console.log(`[TASK_START] Updated task status in database: in_progress`);
          }
        } catch (dbErr) {
          console.error('[TASK_START] Failed to update task status in database:', dbErr);
        }
      });
      // Note: Plan file may not exist yet for new tasks - that's fine (persistPlanStatus handles ENOENT)
    }
  );

  /**
   * Stop a task
   */
  ipcMain.on(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    const DEBUG = process.env.DEBUG === 'true';

    agentManager.killTask(taskId);

    // Notify status change IMMEDIATELY for instant UI feedback
    const ipcSentAt = Date.now();
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(
        IPC_CHANNELS.TASK_STATUS_CHANGE,
        taskId,
        'backlog'
      );
    }

    if (DEBUG) {
      console.log(`[TASK_STOP] IPC sent immediately for task ${taskId}, deferring file persistence`);
    }

    // Find task and project to update the plan file (async, non-blocking)
    const { task, project } = findTaskAndProject(taskId);

    if (task && project) {
      const mainPlanPath = getPlanPath(project, task);
      const worktreePath = findTaskWorktree(project.path, task.specId);

      // Check if task is in early stages (planning phase with no completed coding work)
      // If so, we should clean up the worktree so next start gets fresh repo state
      let shouldCleanupWorktree = false;
      try {
        if (existsSync(mainPlanPath)) {
          const planContent = readFileSync(mainPlanPath, 'utf-8');
          const plan = JSON.parse(planContent);
          const phases = plan.phases || [];

          // Count completed subtasks (excluding any that are just "planning" related)
          let hasCompletedCodingWork = false;
          for (const phase of phases) {
            const subtasks = phase.subtasks || phase.chunks || [];
            for (const subtask of subtasks) {
              if (subtask.status === 'completed') {
                hasCompletedCodingWork = true;
                break;
              }
            }
            if (hasCompletedCodingWork) break;
          }

          // Also check execution phase - if still in planning/idle, safe to clean up
          const executionPhase = task.executionProgress?.phase;
          const isInPlanningPhase = !executionPhase || executionPhase === 'idle' || executionPhase === 'planning';

          shouldCleanupWorktree = !hasCompletedCodingWork || isInPlanningPhase;

          if (DEBUG) {
            console.log(`[TASK_STOP] hasCompletedCodingWork=${hasCompletedCodingWork}, executionPhase=${executionPhase}, shouldCleanupWorktree=${shouldCleanupWorktree}`);
          }
        } else {
          // No plan file means task hasn't started real work yet
          shouldCleanupWorktree = true;
        }
      } catch (err) {
        console.warn('[TASK_STOP] Could not check task progress, will not cleanup worktree:', err);
      }

      setImmediate(async () => {
        const persistStart = Date.now();
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
          } else {
            // Task has completed work, just persist status
            const mainPersisted = await persistPlanStatus(mainPlanPath, 'backlog', project.id);
            if (mainPersisted) {
              console.warn('[TASK_STOP] Updated main plan status to backlog');
            }

            // Also persist to worktree if it exists
            if (worktreePath) {
              const specsBaseDir = getSpecsDir(project.autoBuildPath);
              const worktreePlanPath = path.join(
                worktreePath,
                specsBaseDir,
                task.specId,
                AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
              );
              if (existsSync(worktreePlanPath)) {
                const worktreePersisted = await persistPlanStatus(worktreePlanPath, 'backlog', project.id);
                if (worktreePersisted) {
                  console.warn('[TASK_STOP] Updated worktree plan status to backlog');
                }
              }
            }

            // Dual-write: Update status in SQLite database
            try {
              const storage = getTaskStorage();
              storage.updateTask(taskId, { status: 'backlog' });
              if (DEBUG) {
                console.log(`[TASK_STOP] Updated task status in database: backlog`);
              }
            } catch (dbErr) {
              console.error('[TASK_STOP] Failed to update task status in database:', dbErr);
            }
          }

          if (DEBUG) {
            const delay = persistStart - ipcSentAt;
            const duration = Date.now() - persistStart;
            console.log(`[TASK_STOP] File persistence: delayed ${delay}ms after IPC, completed in ${duration}ms`);
          }
        } catch (err) {
          console.error('[TASK_STOP] Failed to persist plan status:', err);
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

      // 3. Update task status to backlog
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          'backlog'
        );
      }

      // Dual-write: Update status in SQLite database
      try {
        const storage = getTaskStorage();
        storage.updateTask(taskId, { status: 'backlog' });
        if (DEBUG) {
          console.log(`[TASK_RESET] Updated task status in database: backlog`);
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

        // Dual-write: Update status in SQLite database
        try {
          const storage = getTaskStorage();
          storage.updateTask(taskId, { status: 'done' });
          console.debug(`[TASK_REVIEW] Updated task status in database: done`);
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

        // Dual-write: Update status in SQLite database
        try {
          const storage = getTaskStorage();
          storage.updateTask(taskId, { status: 'in_progress' });
          console.debug(`[TASK_REVIEW] Updated task status in database: in_progress`);
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

      // Get the spec directory and plan path using shared utility
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const specDir = path.join(project.path, specsBaseDir, task.specId);
      const planPath = getPlanPath(project, task);

      try {
        // Use shared utility for thread-safe plan file updates
        const persisted = await persistPlanStatus(planPath, status, project.id);

        if (!persisted) {
          // If no implementation plan exists yet, create a basic one
          await createPlanIfNotExists(planPath, task, status);
          // Invalidate cache after creating new plan
          projectStore.invalidateTasksCache(project.id);
        }

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

        // Dual-write: Update status in SQLite database
        try {
          const storage = getTaskStorage();
          storage.updateTask(taskId, { status });
          console.debug(`[TASK_UPDATE_STATUS] Updated task status in database: ${status}`);
        } catch (dbErr) {
          console.error('[TASK_UPDATE_STATUS] Failed to update task status in database:', dbErr);
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

      // Get the spec directory - use task.specsPath if available (handles worktree vs main)
      // This is critical: task might exist in worktree, and getTasks() prefers worktree version.
      // If we write to main project but task is in worktree, the worktree's old status takes precedence on refresh.
      const specDir = task.specsPath || path.join(
        project.path,
        getSpecsDir(project.autoBuildPath),
        task.specId
      );

      // Update implementation_plan.json
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      console.log(`[Recovery] Writing to plan file at: ${planPath} (task location: ${task.location || 'main'})`);

      // Also update the OTHER location if task exists in both main and worktree
      // This ensures consistency regardless of which version getTasks() prefers
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
      const worktreePath = findTaskWorktree(project.path, task.specId);
      const worktreeSpecDir = worktreePath ? path.join(worktreePath, specsBaseDir, task.specId) : null;

      // Collect all plan file paths that need updating
      const planPathsToUpdate: string[] = [planPath];
      if (mainSpecDir !== specDir && existsSync(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(mainSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      if (worktreeSpecDir && worktreeSpecDir !== specDir && existsSync(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN))) {
        planPathsToUpdate.push(path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
      }
      console.log(`[Recovery] Will update ${planPathsToUpdate.length} plan file(s):`, planPathsToUpdate);

      try {
        // Read the plan to analyze subtask progress
        // Using safe read to avoid TOCTOU race conditions
        let plan: Record<string, unknown> | null = null;
        const planContent = safeReadFileSync(planPath);
        if (planContent) {
          try {
            plan = JSON.parse(planContent);
          } catch (parseError) {
            console.error('[Recovery] Failed to parse plan file as JSON:', parseError);
            return {
              success: false,
              error: 'Plan file contains invalid JSON. The file may be corrupted.'
            };
          }
        }

        // Determine the target status intelligently based on subtask progress
        // If targetStatus is explicitly provided, use it; otherwise calculate from subtasks
        let newStatus: TaskStatus = targetStatus || 'backlog';

        if (!targetStatus && plan?.phases && Array.isArray(plan.phases)) {
          // Analyze subtask statuses to determine appropriate recovery status
          const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);

          if (totalCount > 0) {
            if (allCompleted) {
              // All subtasks completed - should go to review (ai_review or human_review based on source)
              // For recovery, human_review is safer as it requires manual verification
              newStatus = 'human_review';
            } else if (completedCount > 0) {
              // Some subtasks completed, some still pending - task is in progress
              newStatus = 'in_progress';
            }
            // else: no subtasks completed, stay with 'backlog'
          }
        }

        if (plan) {
          // Update status
          plan.status = newStatus;
          plan.planStatus = newStatus === 'done' ? 'completed'
            : newStatus === 'in_progress' ? 'in_progress'
            : newStatus === 'ai_review' ? 'review'
            : newStatus === 'human_review' ? 'review'
            : 'pending';
          plan.updated_at = new Date().toISOString();

          // Add recovery note
          plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;

          // Check if task is actually stuck or just completed and waiting for merge
          const { allCompleted } = checkSubtasksCompletion(plan);

          if (allCompleted) {
            console.log('[Recovery] Task is fully complete (all subtasks done), setting to human_review without restart');
            // Don't reset any subtasks - task is done!
            // Just update status in plan file (project store reads from file, no separate update needed)
            plan.status = 'human_review';
            plan.planStatus = 'review';

            // Write to ALL plan file locations to ensure consistency
            const planContent = JSON.stringify(plan, null, 2);
            let writeSucceededForComplete = false;
            for (const pathToUpdate of planPathsToUpdate) {
              try {
                atomicWriteFileSync(pathToUpdate, planContent);
                console.log(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
                writeSucceededForComplete = true;
              } catch (writeError) {
                console.error(`[Recovery] Failed to write plan file at ${pathToUpdate}:`, writeError);
                // Continue trying other paths
              }
            }

            if (!writeSucceededForComplete) {
              return {
                success: false,
                error: 'Failed to write plan file during recovery (all locations failed)'
              };
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

          // Task is not complete - reset only stuck subtasks for retry
          // Keep completed subtasks as-is so run.py can resume from where it left off
          const resetSubtaskIds: string[] = [];
          console.log(`[Recovery] Scanning subtasks in plan...`);
          if (plan.phases && Array.isArray(plan.phases)) {
            for (const phase of plan.phases as Array<{ subtasks?: Array<{ id?: string; status: string; actual_output?: string; started_at?: string; completed_at?: string }> }>) {
              if (phase.subtasks && Array.isArray(phase.subtasks)) {
                for (const subtask of phase.subtasks) {
                  console.log(`[Recovery] Subtask ${subtask.id}: status=${subtask.status}`);
                  // Reset in_progress subtasks to pending (they were interrupted)
                  // Keep completed subtasks as-is so run.py can resume
                  if (subtask.status === 'in_progress') {
                    const originalStatus = subtask.status;
                    subtask.status = 'pending';
                    // Clear execution data to maintain consistency
                    delete subtask.actual_output;
                    delete subtask.started_at;
                    delete subtask.completed_at;
                    if (subtask.id) resetSubtaskIds.push(subtask.id);
                    console.log(`[Recovery] Reset subtask ${subtask.id}: ${originalStatus} -> pending`);
                  }
                  // Also reset failed subtasks so they can be retried
                  if (subtask.status === 'failed') {
                    subtask.status = 'pending';
                    // Clear execution data to maintain consistency
                    delete subtask.actual_output;
                    delete subtask.started_at;
                    delete subtask.completed_at;
                    if (subtask.id) resetSubtaskIds.push(subtask.id);
                    console.log(`[Recovery] Reset subtask ${subtask.id}: failed -> pending`);
                  }
                }
              }
            }
          }

          // Also clear attempt history for reset subtasks so they can be retried fresh
          // Without this, the agent would immediately re-mark them as stuck due to high attempt count
          console.log(`[Recovery] Subtasks reset: ${resetSubtaskIds.length}`, resetSubtaskIds);
          if (resetSubtaskIds.length > 0) {
            // Clear attempt history in ALL locations (specDir, mainSpecDir, worktreeSpecDir)
            const attemptHistoryPaths: string[] = [];

            // Always add specDir
            attemptHistoryPaths.push(path.join(specDir, 'memory', 'attempt_history.json'));

            // Add mainSpecDir if different
            if (mainSpecDir !== specDir) {
              attemptHistoryPaths.push(path.join(mainSpecDir, 'memory', 'attempt_history.json'));
            }

            // Add worktreeSpecDir if different from both
            if (worktreeSpecDir && worktreeSpecDir !== specDir && worktreeSpecDir !== mainSpecDir) {
              attemptHistoryPaths.push(path.join(worktreeSpecDir, 'memory', 'attempt_history.json'));
            }

            console.log(`[Recovery] Will clear attempt history at ${attemptHistoryPaths.length} location(s):`, attemptHistoryPaths);

            for (const attemptHistoryPath of attemptHistoryPaths) {
              try {
                console.log(`[Recovery] Checking attempt history at: ${attemptHistoryPath}`);
                if (existsSync(attemptHistoryPath)) {
                  console.log(`[Recovery] File exists, reading...`);
                  const historyContent = safeReadFileSync(attemptHistoryPath);
                  if (historyContent) {
                    const history = JSON.parse(historyContent);
                    console.log(`[Recovery] Current stuck_subtasks:`, history.stuck_subtasks);
                    console.log(`[Recovery] Current subtasks in history:`, Object.keys(history.subtasks || {}));

                    // Reset attempt history for each subtask
                    for (const subtaskId of resetSubtaskIds) {
                      if (history.subtasks && history.subtasks[subtaskId]) {
                        const oldAttempts = history.subtasks[subtaskId].attempts?.length || 0;
                        history.subtasks[subtaskId] = { attempts: [], status: 'pending' };
                        console.log(`[Recovery] Cleared attempt history for ${subtaskId} (had ${oldAttempts} attempts)`);
                      } else {
                        console.log(`[Recovery] No attempt history found for ${subtaskId}`);
                      }
                    }

                    // Remove reset subtasks from stuck_subtasks list
                    if (history.stuck_subtasks && Array.isArray(history.stuck_subtasks)) {
                      const beforeCount = history.stuck_subtasks.length;
                      history.stuck_subtasks = history.stuck_subtasks.filter(
                        (s: { subtask_id?: string }) => !resetSubtaskIds.includes(s.subtask_id || '')
                      );
                      console.log(`[Recovery] Removed ${beforeCount - history.stuck_subtasks.length} from stuck_subtasks list`);
                    }

                    history.metadata = history.metadata || {};
                    history.metadata.last_updated = new Date().toISOString();

                    atomicWriteFileSync(attemptHistoryPath, JSON.stringify(history, null, 2));
                    console.log(`[Recovery] Successfully wrote updated attempt_history.json`);
                  } else {
                    console.log(`[Recovery] File exists but is empty`);
                  }
                } else {
                  console.log(`[Recovery] File does not exist at: ${attemptHistoryPath}`);
                }
              } catch (historyError) {
                // Log but don't fail - this is a best-effort optimization
                console.error(`[Recovery] ERROR clearing attempt history at ${attemptHistoryPath}:`, historyError);
              }
            }
          }

          // Write to ALL plan file locations to ensure consistency
          const planContent = JSON.stringify(plan, null, 2);
          let writeSucceeded = false;
          for (const pathToUpdate of planPathsToUpdate) {
            try {
              atomicWriteFileSync(pathToUpdate, planContent);
              console.log(`[Recovery] Successfully wrote to: ${pathToUpdate}`);
              writeSucceeded = true;
            } catch (writeError) {
              console.error(`[Recovery] Failed to write plan file at ${pathToUpdate}:`, writeError);
            }
          }
          if (!writeSucceeded) {
            return {
              success: false,
              error: 'Failed to write plan file during recovery'
            };
          }
        }

        // Auto-restart the task if requested
        let autoRestarted = false;
        if (autoRestart && project) {
          // Check git status before auto-restarting
          const gitStatusForRestart = checkGitStatus(project.path);
          if (!gitStatusForRestart.isGitRepo || !gitStatusForRestart.hasCommits) {
            console.warn('[Recovery] Git check failed, cannot auto-restart task');
            // Recovery succeeded but we can't restart without git
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
            // Recovery succeeded but we can't restart without auth
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

            // Update plan status for restart - write to ALL locations
            if (plan) {
              plan.status = 'in_progress';
              plan.planStatus = 'in_progress';
              const restartPlanContent = JSON.stringify(plan, null, 2);
              for (const pathToUpdate of planPathsToUpdate) {
                try {
                  atomicWriteFileSync(pathToUpdate, restartPlanContent);
                  console.log(`[Recovery] Wrote restart status to: ${pathToUpdate}`);
                } catch (writeError) {
                  console.error(`[Recovery] Failed to write plan file for restart at ${pathToUpdate}:`, writeError);
                  // Continue with restart attempt even if file write fails
                  // The plan status will be updated by the agent when it starts
                }
              }
            }

            // Start the task execution
            // Start file watcher for this task
            const specsBaseDir = getSpecsDir(project.autoBuildPath);
            const specDirForWatcher = path.join(project.path, specsBaseDir, task.specId);
            // Also watch worktree directory for real-time updates
            const worktreePathForRecovery = findTaskWorktree(project.path, task.specId);
            const worktreeSpecDirForRecovery = worktreePathForRecovery
              ? path.join(worktreePathForRecovery, specsBaseDir, task.specId)
              : undefined;

            // Check if spec.md exists to determine whether to run spec creation or task execution
            const specFilePath = path.join(specDirForWatcher, AUTO_BUILD_PATHS.SPEC_FILE);
            const hasSpec = existsSync(specFilePath);
            const needsSpecCreation = !hasSpec;

            // Get base branch: task-level override takes precedence over project settings
            const baseBranchForRecovery = task.metadata?.baseBranch || project.settings?.mainBranch;

            if (needsSpecCreation) {
              // No spec file - need to run spec_runner.py to create the spec
              const taskDescription = task.description || task.title;
              console.warn(`[Recovery] Starting spec creation for: ${task.specId}`);
              agentManager.startSpecCreation(task.specId, project.path, taskDescription, specDirForWatcher, task.metadata, baseBranchForRecovery);
            } else {
              // Spec exists - run task execution
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

        // Dual-write: Update status in SQLite database
        try {
          const storage = getTaskStorage();
          storage.updateTask(taskId, { status: newStatus });
          console.debug(`[TASK_RECOVER_STUCK] Updated task status in database: ${newStatus}`);
        } catch (dbErr) {
          console.error('[TASK_RECOVER_STUCK] Failed to update task status in database:', dbErr);
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
