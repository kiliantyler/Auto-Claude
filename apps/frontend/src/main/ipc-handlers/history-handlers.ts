/**
 * History IPC Handlers
 * ====================
 *
 * IPC handlers for task history/audit logging operations.
 * These handlers expose the HistoryService to the renderer process.
 *
 * Available handlers:
 * - history:get-task-history - Get full history for a specific task
 * - history:get-recent - Get recent changes across all tasks
 * - history:get-session - Get all changes for a specific session
 * - history:is-enabled - Check if history feature is enabled
 * - history:get-recent-sessions - Get list of recent sessions
 * - history:query - Query history with flexible filters
 */

import { ipcMain } from 'electron';
import type {
  IPCResult,
  HistoryQueryOptions,
  HistoryQueryResult,
  SessionHistoryGroup,
  RecentActivityItem,
} from '../../shared/types';
import { getHistoryService } from '../history-service';
import { projectStore } from '../project-store';

// IPC channel names for history operations
export const HISTORY_CHANNELS = {
  GET_TASK_HISTORY: 'history:get-task-history',
  GET_RECENT: 'history:get-recent',
  GET_SESSION: 'history:get-session',
  IS_ENABLED: 'history:is-enabled',
  GET_RECENT_SESSIONS: 'history:get-recent-sessions',
  QUERY: 'history:query',
  GET_TASK_HISTORY_COUNT: 'history:get-task-history-count',
} as const;

/**
 * Helper to get project path from projectId
 */
function getProjectPath(projectId: string): string | null {
  const project = projectStore.getProject(projectId);
  if (!project) {
    console.warn(`[History Handlers] Project not found: ${projectId}`);
    return null;
  }
  return project.path;
}

/**
 * Register history IPC handlers
 *
 * Follows the same pattern as crud-handlers.ts - simple registration function
 * that sets up all handlers when called.
 */
export function registerHistoryHandlers(): void {
  console.log('[History Handlers] Registering history IPC handlers');

  /**
   * Check if history feature is enabled
   * Returns true if ENABLE_TASK_HISTORY is not set to 'false'
   */
  ipcMain.handle(
    HISTORY_CHANNELS.IS_ENABLED,
    async (): Promise<IPCResult<boolean>> => {
      try {
        const service = getHistoryService();
        const enabled = service.isEnabled();
        return { success: true, data: enabled };
      } catch (error) {
        console.error('[History Handlers] Failed to check if history is enabled:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check history status',
        };
      }
    }
  );

  /**
   * Get full history for a specific task
   *
   * @param projectId - Project ID (required)
   * @param taskId - Task ID to get history for
   * @param options - Optional query options (limit, offset)
   * @returns HistoryQueryResult with entries and pagination info
   */
  ipcMain.handle(
    HISTORY_CHANNELS.GET_TASK_HISTORY,
    async (
      _,
      projectId: string,
      taskId: string,
      options?: { limit?: number; offset?: number }
    ): Promise<IPCResult<HistoryQueryResult>> => {
      console.log('[History Handlers] GET_TASK_HISTORY called for task:', taskId);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!taskId) {
        return { success: false, error: 'Task ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const result = service.getTaskHistory(projectPath, taskId, options);
        console.log(
          '[History Handlers] GET_TASK_HISTORY returning',
          result.entries.length,
          'entries'
        );
        return { success: true, data: result };
      } catch (error) {
        console.error('[History Handlers] Failed to get task history:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task history',
        };
      }
    }
  );

  /**
   * Get recent changes across all tasks in a project
   *
   * @param projectId - Project ID (required)
   * @param limit - Maximum number of entries to return (default 50)
   * @param options - Optional filters (action type, date range)
   * @returns Array of history entries with task info
   */
  ipcMain.handle(
    HISTORY_CHANNELS.GET_RECENT,
    async (
      _,
      projectId: string,
      limit: number = 50,
      options?: HistoryQueryOptions
    ): Promise<IPCResult<RecentActivityItem[]>> => {
      console.log('[History Handlers] GET_RECENT called with limit:', limit);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const entries = service.getRecentChanges(projectPath, limit, options);
        console.log('[History Handlers] GET_RECENT returning', entries.length, 'entries');
        return { success: true, data: entries };
      } catch (error) {
        console.error('[History Handlers] Failed to get recent changes:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get recent changes',
        };
      }
    }
  );

  /**
   * Get all changes for a specific session
   *
   * Sessions group related changes that were made together (e.g., during a single edit session).
   *
   * @param projectId - Project ID (required)
   * @param sessionId - Session ID to get changes for
   * @returns SessionHistoryGroup with all changes in the session, or null if not found
   */
  ipcMain.handle(
    HISTORY_CHANNELS.GET_SESSION,
    async (_, projectId: string, sessionId: string): Promise<IPCResult<SessionHistoryGroup | null>> => {
      console.log('[History Handlers] GET_SESSION called for session:', sessionId);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!sessionId) {
        return { success: false, error: 'Session ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const sessionGroup = service.getSessionChanges(projectPath, sessionId);
        console.log(
          '[History Handlers] GET_SESSION returning',
          sessionGroup?.entries.length ?? 0,
          'entries'
        );
        return { success: true, data: sessionGroup };
      } catch (error) {
        console.error('[History Handlers] Failed to get session changes:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session changes',
        };
      }
    }
  );

  /**
   * Get all distinct sessions with their entry counts
   *
   * Useful for displaying a session picker in the UI.
   *
   * @param projectId - Project ID (required)
   * @param limit - Maximum number of sessions to return (default 20)
   * @returns Array of session info objects
   */
  ipcMain.handle(
    HISTORY_CHANNELS.GET_RECENT_SESSIONS,
    async (
      _,
      projectId: string,
      limit: number = 20
    ): Promise<IPCResult<{ sessionId: string; entryCount: number; lastActivity: string }[]>> => {
      console.log('[History Handlers] GET_RECENT_SESSIONS called with limit:', limit);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const sessions = service.getRecentSessions(projectPath, limit);
        console.log('[History Handlers] GET_RECENT_SESSIONS returning', sessions.length, 'sessions');
        return { success: true, data: sessions };
      } catch (error) {
        console.error('[History Handlers] Failed to get recent sessions:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get recent sessions',
        };
      }
    }
  );

  /**
   * Query history with flexible filters
   *
   * @param projectId - Project ID (required)
   * @param options - Query options with filters and pagination
   * @returns HistoryQueryResult with entries and pagination info
   */
  ipcMain.handle(
    HISTORY_CHANNELS.QUERY,
    async (_, projectId: string, options: HistoryQueryOptions): Promise<IPCResult<HistoryQueryResult>> => {
      console.log('[History Handlers] QUERY called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const result = service.queryHistory(projectPath, options || {});
        console.log('[History Handlers] QUERY returning', result.entries.length, 'entries');
        return { success: true, data: result };
      } catch (error) {
        console.error('[History Handlers] Failed to query history:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to query history',
        };
      }
    }
  );

  /**
   * Get the count of history entries for a task
   *
   * @param projectId - Project ID (required)
   * @param taskId - Task ID to count history for
   * @returns Number of history entries
   */
  ipcMain.handle(
    HISTORY_CHANNELS.GET_TASK_HISTORY_COUNT,
    async (_, projectId: string, taskId: string): Promise<IPCResult<number>> => {
      console.log('[History Handlers] GET_TASK_HISTORY_COUNT called for task:', taskId);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!taskId) {
        return { success: false, error: 'Task ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getHistoryService();
        const count = service.getTaskHistoryCount(projectPath, taskId);
        console.log('[History Handlers] GET_TASK_HISTORY_COUNT returning:', count);
        return { success: true, data: count };
      } catch (error) {
        console.error('[History Handlers] Failed to get task history count:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task history count',
        };
      }
    }
  );

  console.log('[History Handlers] All history IPC handlers registered successfully');
}
