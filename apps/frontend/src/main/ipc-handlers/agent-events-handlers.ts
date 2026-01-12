import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  SDKRateLimitInfo,
  Task,
  TaskStatus,
  Project,
  ExecutionProgress
} from '../../shared/types';
import { AgentManager } from '../agent';
import type { ProcessType, ExecutionProgressData } from '../agent';
import { titleGenerator } from '../title-generator';
import { projectStore } from '../project-store';
import { notificationService } from '../notification-service';
import { findTaskAndProject } from './task/shared';
import { getProjectTaskStorage } from '../task-storage';


/**
 * Register all agent-events-related IPC handlers
 *
 * NOTE: All task data persistence now goes through SQLite database.
 * JSON files are no longer written or read during runtime.
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
          const projectId = project.id;

          // Persist status to SQLite database
          const persistStatus = (status: TaskStatus) => {
            try {
              const storage = getProjectTaskStorage(project!.path);
              storage.updateTask(task!.id, { status });
              projectStore.invalidateTasksCache(projectId);
              console.warn(`[Task ${taskId}] Persisted status to database: ${status}`);
            } catch (err) {
              console.error(`[Task ${taskId}] Failed to persist status:`, err);
            }
          };

          if (code === 0) {
            // Fallback: Ensure status is updated even if COMPLETE phase event was missed
            // This prevents tasks from getting stuck in ai_review status
            // CRITICAL: Only move to human_review if there ARE subtasks and they're all completed
            // If there are no subtasks, the task is still in planning phase - don't change status
            const isActiveStatus = task.status === 'in_progress' || task.status === 'ai_review';
            const hasSubtasks = task.subtasks && task.subtasks.length > 0;
            const allSubtasksCompleted = hasSubtasks &&
              task.subtasks.every((s) => s.status === 'completed');

            if (isActiveStatus && hasSubtasks && allSubtasksCompleted) {
              console.warn(`[Task ${taskId}] Fallback: Moving to human_review (all subtasks completed)`);
              notificationService.notifyReviewNeeded(taskTitle, project.id, taskId);
              persistStatus('human_review');
              // Include projectId for multi-project filtering (issue #723)
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_STATUS_CHANGE,
                taskId,
                'human_review' as TaskStatus,
                projectId
              );
            } else if (isActiveStatus && !hasSubtasks) {
              // No subtasks yet - task is still in planning phase, keep as backlog
              console.warn(`[Task ${taskId}] Process exited with no subtasks - resetting to backlog`);
              persistStatus('backlog');
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_STATUS_CHANGE,
                taskId,
                'backlog' as TaskStatus,
                projectId
              );
            }
          } else {
            // Process failed - only notify and update if there were subtasks
            // If no subtasks, the planning phase failed - reset to backlog
            const hasSubtasks = task.subtasks && task.subtasks.length > 0;
            if (hasSubtasks) {
              notificationService.notifyTaskFailed(taskTitle, project.id, taskId);
              persistStatus('human_review');
              // Include projectId for multi-project filtering (issue #723)
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_STATUS_CHANGE,
                taskId,
                'human_review' as TaskStatus,
                projectId
              );
            } else {
              console.warn(`[Task ${taskId}] Process failed during planning - resetting to backlog`);
              persistStatus('backlog');
              mainWindow.webContents.send(
                IPC_CHANNELS.TASK_STATUS_CHANGE,
                taskId,
                'backlog' as TaskStatus,
                projectId
              );
            }
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
      if (newStatus && task && project) {
        // Include projectId in status change event for multi-project filtering
        mainWindow.webContents.send(
          IPC_CHANNELS.TASK_STATUS_CHANGE,
          taskId,
          newStatus,
          taskProjectId
        );

        // Persist status and execution progress to SQLite database
        try {
          const storage = getProjectTaskStorage(project.path);
          const executionProgress: ExecutionProgress = {
            phase: progress.phase,
            phaseProgress: progress.phaseProgress || 0,
            overallProgress: progress.overallProgress || 0,
            currentSubtask: progress.currentSubtask,
            message: progress.message
          };

          storage.updateTask(task.id, {
            status: newStatus,
            executionProgress
          });

          projectStore.invalidateTasksCache(project.id);
          console.debug(`[execution-progress] Updated task ${task.id} status: ${newStatus}`);
        } catch (err) {
          console.warn('[execution-progress] Could not persist to database:', err);
        }
      }
    }
  });
}
