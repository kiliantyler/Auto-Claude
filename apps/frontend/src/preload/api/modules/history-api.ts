import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  TaskHistoryEntry,
  HistoryQueryOptions,
  HistoryQueryResult,
  SessionHistoryGroup,
  RecentActivityItem,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * History API operations for task audit logging
 * Phase 4A - Task History & Audit Log
 */
export interface HistoryAPI {
  // Core History Operations
  getTaskHistory: (taskId: string, limit?: number) => Promise<IPCResult<TaskHistoryEntry[]>>;
  getRecentChanges: (limit?: number) => Promise<IPCResult<RecentActivityItem[]>>;
  getSessionChanges: (sessionId: string) => Promise<IPCResult<SessionHistoryGroup>>;

  // Feature Flag
  isEnabled: () => Promise<IPCResult<boolean>>;

  // Session Operations
  getRecentSessions: (limit?: number) => Promise<IPCResult<SessionHistoryGroup[]>>;

  // Advanced Queries
  query: (options: HistoryQueryOptions) => Promise<IPCResult<HistoryQueryResult>>;

  // Utility
  getTaskHistoryCount: (taskId: string) => Promise<IPCResult<number>>;
}

/**
 * Creates the History API implementation
 */
export const createHistoryAPI = (): HistoryAPI => ({
  // Core History Operations
  getTaskHistory: (taskId: string, limit?: number): Promise<IPCResult<TaskHistoryEntry[]>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_GET_TASK_HISTORY, taskId, limit),

  getRecentChanges: (limit?: number): Promise<IPCResult<RecentActivityItem[]>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_GET_RECENT, limit),

  getSessionChanges: (sessionId: string): Promise<IPCResult<SessionHistoryGroup>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_GET_SESSION, sessionId),

  // Feature Flag
  isEnabled: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_IS_ENABLED),

  // Session Operations
  getRecentSessions: (limit?: number): Promise<IPCResult<SessionHistoryGroup[]>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_GET_RECENT_SESSIONS, limit),

  // Advanced Queries
  query: (options: HistoryQueryOptions): Promise<IPCResult<HistoryQueryResult>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_QUERY, options),

  // Utility
  getTaskHistoryCount: (taskId: string): Promise<IPCResult<number>> =>
    invokeIpc(IPC_CHANNELS.HISTORY_GET_TASK_HISTORY_COUNT, taskId)
});
