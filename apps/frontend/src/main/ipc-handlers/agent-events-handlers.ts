import type { BrowserWindow } from 'electron';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import type {
  SDKRateLimitInfo,
  Task,
  TaskStatus,
  Project,
  ImplementationPlan,
  Subtask,
  SubtaskStatus
} from '../../shared/types';
import { AgentManager } from '../agent';
import type { ProcessType, ExecutionProgressData } from '../agent';
import { titleGenerator } from '../title-generator';
import { projectStore } from '../project-store';
import { notificationService } from '../notification-service';
import { persistPlanStatusSync, getPlanPath } from './task/plan-file-utils';
import { findTaskWorktree } from '../worktree-paths';
import { findTaskAndProject } from './task/shared';
import { getTaskStorage } from '../task-storage';


/**
 * Register all agent-events-related IPC handlers
 */
export function registerAgenteventsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Agent Manager Events → Renderer
  // ============================================

  agentManager.on('log', (taskId: string, log: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Include projectId for multi-project filtering (issue #723)
      const { project } = findTaskAndProject(taskId);
      mainWindow.webContents.send(IPC_CHANNELS.TASK_LOG, taskId, log, project?.id);
    }
  });

  agentManager.on('error', (taskId: string, error: string) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Include projectId for multi-project filtering (issue #723)
      const { project } = findTaskAndProject(taskId);
      mainWindow.webContents.send(IPC_CHANNELS.TASK_ERROR, taskId, error, project?.id);
    }
  });

  // Handle SDK rate limit events from agent manager
  agentManager.on('sdk-rate-limit', (rateLimitInfo: SDKRateLimitInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
    }
  });

  // Handle SDK rate limit events from title generator
  titleGenerator.on('sdk-rate-limit', (rateLimitInfo: SDKRateLimitInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.CLAUDE_SDK_RATE_LIMIT, rateLimitInfo);
    }
  });

  agentManager.on('exit', (taskId: string, code: number | null, processType: ProcessType) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Get project info early for multi-project filtering (issue #723)
      const { project: exitProject } = findTaskAndProject(taskId);
      const exitProjectId = exitProject?.id;

      if (processType === 'spec-creation') {
        console.warn(`[Task ${taskId}] Spec creation completed with code ${code}`);
        return;
      }

      let task: Task | undefined;
      let project: Project | undefined;

      try {
        const projects = projectStore.getProjects();

        // IMPORTANT: Invalidate cache for all projects to ensure we get fresh data
        // This prevents race conditions where cached task data has stale status
        for (const p of projects) {
          projectStore.invalidateTasksCache(p.id);
        }

        for (const p of projects) {
          const tasks = projectStore.getTasks(p.id);
          task = tasks.find((t) => t.id === taskId || t.specId === taskId);
          if (task) {
            project = p;
            break;
          }
        }

        if (task && project) {
          const taskTitle = task.title || task.specId;
          const mainPlanPath = getPlanPath(project, task);
          const projectId = project.id; // Capture for closure

          // Capture task values for closure
          const taskSpecId = task.specId;
          const projectPath = project.path;
          const autoBuildPath = project.autoBuildPath;

          // Use shared utility for persisting status (prevents race conditions)
          // Persist to both main project AND worktree (if exists) for consistency
          const persistStatus = (status: TaskStatus) => {
            // Persist to main project
            const mainPersisted = persistPlanStatusSync(mainPlanPath, status, projectId);
            if (mainPersisted) {
              console.warn(`[Task ${taskId}] Persisted status to main plan: ${status}`);
            }

            // Also persist to worktree if it exists
            const worktreePath = findTaskWorktree(projectPath, taskSpecId);
            if (worktreePath) {
              const specsBaseDir = getSpecsDir(autoBuildPath);
              const worktreePlanPath = path.join(
                worktreePath,
                specsBaseDir,
                taskSpecId,
                AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
              );
              if (existsSync(worktreePlanPath)) {
                const worktreePersisted = persistPlanStatusSync(worktreePlanPath, status, projectId);
                if (worktreePersisted) {
                  console.warn(`[Task ${taskId}] Persisted status to worktree plan: ${status}`);
                }
              }
            }
          };

          if (code === 0) {
            notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);

            // Fallback: Ensure status is updated even if COMPLETE phase event was missed
            // This prevents tasks from getting stuck in ai_review status
            // Uses inverted logic to also handle tasks with no subtasks (treats them as complete)
            const isActiveStatus = task.status === 'in_progress' || task.status === 'ai_review';
            const hasIncompleteSubtasks = task.subtasks && task.subtasks.length > 0 &&
              task.subtasks.some((s) => s.status !== 'completed');

            if (isActiveStatus && !hasIncompleteSubtasks) {
              console.warn(`[Task ${taskId}] Fallback: Moving to human_review (process exited successfully)`);
              persistStatus('human_review');
              // Include projectId for multi-project filtering (issue #723)
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_STATUS_CHANGE,
                taskId,
                'human_review' as TaskStatus,
                projectId
              );
            }
          } else {
            notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
            persistStatus('human_review');
            // Include projectId for multi-project filtering (issue #723)
            mainWindow.webContents.send(
              IPC_CHANNELS.TASK_STATUS_CHANGE,
              taskId,
              'human_review' as TaskStatus,
              projectId
            );
          }
        }
      } catch (error) {
        console.error(`[Task ${taskId}] Exit handler error:`, error);
      }
    }
  });

  agentManager.on('execution-progress', (taskId: string, progress: ExecutionProgressData) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // Use shared helper to find task and project (issue #723 - deduplicate lookup)
      const { task, project } = findTaskAndProject(taskId);
      const taskProjectId = project?.id;

      // Include projectId in execution progress event for multi-project filtering
      mainWindow.webContents.send(IPC_CHANNELS.TASK_EXECUTION_PROGRESS, taskId, progress, taskProjectId);

      const phaseToStatus: Record<string, TaskStatus | null> = {
        'idle': null,
        'planning': 'in_progress',
        'coding': 'in_progress',
        'qa_review': 'ai_review',
        'qa_fixing': 'ai_review',
        'complete': 'human_review',
        'failed': 'human_review'
      };

      const newStatus = phaseToStatus[progress.phase];
      if (newStatus) {
        // Include projectId in status change event for multi-project filtering
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          newStatus,
          taskProjectId
        );

        // CRITICAL: Persist status to plan file(s) to prevent flip-flop on task list refresh
        // When getTasks() is called, it reads status from the plan file. Without persisting,
        // the status in the file might differ from the UI, causing inconsistent state.
        // Uses shared utility with locking to prevent race conditions.
        // IMPORTANT: We persist to BOTH main project AND worktree (if exists) to ensure
        // consistency, since getTasks() prefers the worktree version.
        if (task && project) {
          try {
            // Persist to main project plan file
            const mainPlanPath = getPlanPath(project, task);
            persistPlanStatusSync(mainPlanPath, newStatus, project.id);

            // Also persist to worktree plan file if it exists
            // This ensures consistency since getTasks() prefers worktree version
            const worktreePath = findTaskWorktree(project.path, task.specId);
            if (worktreePath) {
              const specsBaseDir = getSpecsDir(project.autoBuildPath);
              const worktreePlanPath = path.join(
                worktreePath,
                specsBaseDir,
                task.specId,
                AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
              );
              if (existsSync(worktreePlanPath)) {
                persistPlanStatusSync(worktreePlanPath, newStatus, project.id);
              }
            }

            // CRITICAL: Sync plan data (including subtasks) to SQLite database
            // This ensures subtasks are available even after app restart
            syncPlanToDatabase(task, project, progress);
          } catch (err) {
            // Ignore persistence errors - UI will still work, just might flip on refresh
            console.warn('[execution-progress] Could not persist status:', err);
          }
        }
      }
    }
  });
}

/**
 * Sync implementation plan data (subtasks, execution progress) to SQLite database
 * Called during execution-progress events to keep database in sync with plan file
 */
function syncPlanToDatabase(task: Task, project: Project, progress: ExecutionProgressData): void {
  try {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);

    // Try worktree plan first (more up-to-date during execution), then main
    const worktreePath = findTaskWorktree(project.path, task.specId);
    let planPath = path.join(project.path, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

    if (worktreePath) {
      const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      if (existsSync(worktreePlanPath)) {
        planPath = worktreePlanPath;
      }
    }

    if (!existsSync(planPath)) {
      return;
    }

    // Read and parse the plan file
    const planContent = readFileSync(planPath, 'utf-8');
    const plan = JSON.parse(planContent) as ImplementationPlan;

    // Extract subtasks from phases
    const subtasks: Subtask[] = plan.phases?.flatMap((phase) => {
      const items = phase.subtasks || [];
      return items.map((subtask) => {
        // Handle both 'id' and 'subtask_id' field names
        const subtaskAny = subtask as unknown as Record<string, unknown>;
        const subtaskId = subtask.id || (subtaskAny.subtask_id as string);
        const subtaskDesc = subtask.description || (subtaskAny.title as string);

        // Normalize subtask status
        let status: SubtaskStatus = 'pending';
        const rawStatus = (subtask.status || '').toLowerCase();
        if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'passed') {
          status = 'completed';
        } else if (rawStatus === 'in_progress' || rawStatus === 'running') {
          status = 'in_progress';
        } else if (rawStatus === 'failed' || rawStatus === 'error') {
          status = 'failed';
        }

        return {
          id: subtaskId,
          title: subtaskDesc,
          description: subtaskDesc,
          status,
          files: [],
          verification: subtask.verification
        };
      });
    }) || [];

    // Update SQLite database with subtasks and execution progress
    const storage = getTaskStorage();
    storage.updateTask(task.id, {
      subtasks,
      executionProgress: {
        phase: progress.phase,
        phaseProgress: progress.phaseProgress || 0,
        overallProgress: progress.overallProgress || 0,
        currentSubtask: progress.currentSubtask,
        message: progress.message
      }
    });

    console.debug(`[syncPlanToDatabase] Updated task ${task.id} with ${subtasks.length} subtasks`);
  } catch (err) {
    // Don't fail execution if sync fails - just log warning
    console.warn('[syncPlanToDatabase] Failed to sync plan to database:', err);
  }
}
