import { create } from 'zustand';
import type {
  TaskHistoryEntry,
  HistoryQueryOptions,
  HistoryQueryResult,
  SessionHistoryGroup,
  RecentActivityItem,
  HistoryAction
} from '../../shared/types';

interface HistoryState {
  // History entries indexed by task ID
  taskHistories: Record<string, TaskHistoryEntry[]>;
  // Recent activity across all tasks
  recentActivity: RecentActivityItem[];
  // Session-grouped history
  sessions: SessionHistoryGroup[];
  // Currently selected task ID for history view
  selectedTaskId: string | null;
  // Filter state
  actionFilter: HistoryAction | null;
  // Loading states
  isLoading: boolean;
  isLoadingRecent: boolean;
  // Error state
  error: string | null;
  // Feature flag
  isEnabled: boolean;

  // Actions
  setTaskHistory: (taskId: string, entries: TaskHistoryEntry[]) => void;
  appendTaskHistory: (taskId: string, entries: TaskHistoryEntry[]) => void;
  clearTaskHistory: (taskId: string) => void;
  setRecentActivity: (activity: RecentActivityItem[]) => void;
  setSessions: (sessions: SessionHistoryGroup[]) => void;
  selectTask: (taskId: string | null) => void;
  setActionFilter: (action: HistoryAction | null) => void;
  setLoading: (loading: boolean) => void;
  setLoadingRecent: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  clearAll: () => void;

  // Selectors
  getTaskHistory: (taskId: string) => TaskHistoryEntry[];
  getFilteredTaskHistory: (taskId: string) => TaskHistoryEntry[];
  getSelectedTaskHistory: () => TaskHistoryEntry[];
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  taskHistories: {},
  recentActivity: [],
  sessions: [],
  selectedTaskId: null,
  actionFilter: null,
  isLoading: false,
  isLoadingRecent: false,
  error: null,
  isEnabled: false,

  setTaskHistory: (taskId, entries) =>
    set((state) => ({
      taskHistories: {
        ...state.taskHistories,
        [taskId]: entries
      }
    })),

  appendTaskHistory: (taskId, entries) =>
    set((state) => ({
      taskHistories: {
        ...state.taskHistories,
        [taskId]: [...(state.taskHistories[taskId] || []), ...entries]
      }
    })),

  clearTaskHistory: (taskId) =>
    set((state) => {
      const newHistories = { ...state.taskHistories };
      delete newHistories[taskId];
      return { taskHistories: newHistories };
    }),

  setRecentActivity: (activity) => set({ recentActivity: activity }),

  setSessions: (sessions) => set({ sessions }),

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  setActionFilter: (action) => set({ actionFilter: action }),

  setLoading: (isLoading) => set({ isLoading }),

  setLoadingRecent: (isLoadingRecent) => set({ isLoadingRecent }),

  setError: (error) => set({ error }),

  setEnabled: (isEnabled) => set({ isEnabled }),

  clearAll: () =>
    set({
      taskHistories: {},
      recentActivity: [],
      sessions: [],
      selectedTaskId: null,
      actionFilter: null,
      error: null
    }),

  getTaskHistory: (taskId) => {
    const state = get();
    return state.taskHistories[taskId] || [];
  },

  getFilteredTaskHistory: (taskId) => {
    const state = get();
    const entries = state.taskHistories[taskId] || [];
    if (!state.actionFilter) {
      return entries;
    }
    return entries.filter((entry) => entry.action === state.actionFilter);
  },

  getSelectedTaskHistory: () => {
    const state = get();
    if (!state.selectedTaskId) {
      return [];
    }
    return state.getFilteredTaskHistory(state.selectedTaskId);
  }
}));

// ============================================
// Async Actions (outside store for cleaner API)
// ============================================

/**
 * Check if history feature is enabled
 */
export async function checkHistoryEnabled(): Promise<boolean> {
  const store = useHistoryStore.getState();

  try {
    const result = await window.electronAPI.isEnabled();
    if (result.success && result.data !== undefined) {
      store.setEnabled(result.data);
      return result.data;
    }
    return false;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to check history status');
    return false;
  }
}

/**
 * Load history entries for a specific task
 */
export async function loadTaskHistory(taskId: string, limit?: number): Promise<void> {
  const store = useHistoryStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getTaskHistory(taskId, limit);
    if (result.success && result.data) {
      store.setTaskHistory(taskId, result.data);
    } else {
      store.setError(result.error || 'Failed to load task history');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading task history');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Load recent activity across all tasks
 */
export async function loadRecentActivity(limit?: number): Promise<void> {
  const store = useHistoryStore.getState();
  store.setLoadingRecent(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getRecentChanges(limit);
    if (result.success && result.data) {
      store.setRecentActivity(result.data);
    } else {
      store.setError(result.error || 'Failed to load recent activity');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading recent activity');
  } finally {
    store.setLoadingRecent(false);
  }
}

/**
 * Load history entries for a specific session
 */
export async function loadSessionHistory(sessionId: string): Promise<SessionHistoryGroup | null> {
  const store = useHistoryStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getSessionChanges(sessionId);
    if (result.success && result.data) {
      return result.data;
    } else {
      store.setError(result.error || 'Failed to load session history');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading session history');
    return null;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Load recent sessions
 */
export async function loadRecentSessions(limit?: number): Promise<void> {
  const store = useHistoryStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getRecentSessions(limit);
    if (result.success && result.data) {
      store.setSessions(result.data);
    } else {
      store.setError(result.error || 'Failed to load recent sessions');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading recent sessions');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Query history with advanced options
 */
export async function queryHistory(options: HistoryQueryOptions): Promise<HistoryQueryResult | null> {
  const store = useHistoryStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.query(options);
    if (result.success && result.data) {
      // If querying for a specific task, update that task's history
      if (options.taskId) {
        store.setTaskHistory(options.taskId, result.data.entries);
      }
      return result.data;
    } else {
      store.setError(result.error || 'Failed to query history');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error querying history');
    return null;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Get history entry count for a task
 */
export async function getTaskHistoryCount(taskId: string): Promise<number> {
  try {
    const result = await window.electronAPI.getTaskHistoryCount(taskId);
    if (result.success && result.data !== undefined) {
      return result.data;
    }
    return 0;
  } catch {
    return 0;
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format a history entry for display
 */
export function formatHistoryAction(action: HistoryAction): string {
  switch (action) {
    case 'created':
      return 'Created';
    case 'updated':
      return 'Updated';
    case 'deleted':
      return 'Deleted';
    case 'status_changed':
      return 'Status Changed';
    case 'moved':
      return 'Moved';
    default:
      return action;
  }
}

/**
 * Get icon class for a history action
 */
export function getHistoryActionIcon(action: HistoryAction): string {
  switch (action) {
    case 'created':
      return 'plus-circle';
    case 'updated':
      return 'edit';
    case 'deleted':
      return 'trash';
    case 'status_changed':
      return 'refresh-cw';
    case 'moved':
      return 'move';
    default:
      return 'circle';
  }
}

/**
 * Get color class for a history action
 */
export function getHistoryActionColor(action: HistoryAction): string {
  switch (action) {
    case 'created':
      return 'text-green-500';
    case 'updated':
      return 'text-blue-500';
    case 'deleted':
      return 'text-red-500';
    case 'status_changed':
      return 'text-yellow-500';
    case 'moved':
      return 'text-purple-500';
    default:
      return 'text-gray-500';
  }
}

/**
 * Parse JSON value from history entry safely
 */
export function parseHistoryValue<T>(value: string | undefined | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Group history entries by date
 */
export function groupHistoryByDate(entries: TaskHistoryEntry[]): Record<string, TaskHistoryEntry[]> {
  const groups: Record<string, TaskHistoryEntry[]> = {};

  for (const entry of entries) {
    const date = new Date(entry.timestamp).toLocaleDateString();
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(entry);
  }

  return groups;
}
