import { create } from 'zustand';
import type {
  UndoStackEntry,
  UndoStackState,
  UndoResult,
  UndoClearOptions
} from '../../shared/types';

interface UndoState {
  // Undo/Redo stack state
  undoStack: UndoStackEntry[];
  redoStack: UndoStackEntry[];
  // Availability flags
  canUndo: boolean;
  canRedo: boolean;
  // Processing state
  isProcessing: boolean;
  // Last operation descriptions (for UI display)
  lastUndoDescription: string | null;
  lastRedoDescription: string | null;
  // Loading and error states
  isLoading: boolean;
  error: string | null;
  // Feature flag
  isEnabled: boolean;

  // Actions
  setStackState: (state: UndoStackState) => void;
  setUndoStack: (stack: UndoStackEntry[]) => void;
  setRedoStack: (stack: UndoStackEntry[]) => void;
  setCanUndo: (canUndo: boolean) => void;
  setCanRedo: (canRedo: boolean) => void;
  setProcessing: (processing: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  clearStacks: () => void;
  reset: () => void;

  // Selectors
  getLastUndoEntry: () => UndoStackEntry | null;
  getLastRedoEntry: () => UndoStackEntry | null;
  getUndoCount: () => number;
  getRedoCount: () => number;
}

const initialState = {
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  isProcessing: false,
  lastUndoDescription: null,
  lastRedoDescription: null,
  isLoading: false,
  error: null,
  isEnabled: false,
};

export const useUndoStore = create<UndoState>((set, get) => ({
  ...initialState,

  setStackState: (state) =>
    set({
      undoStack: state.undoStack,
      redoStack: state.redoStack,
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      isProcessing: state.isProcessing,
      lastUndoDescription: state.lastUndoDescription ?? null,
      lastRedoDescription: state.lastRedoDescription ?? null,
    }),

  setUndoStack: (undoStack) =>
    set({
      undoStack,
      canUndo: undoStack.length > 0,
      lastUndoDescription: undoStack.length > 0 ? undoStack[0].description : null,
    }),

  setRedoStack: (redoStack) =>
    set({
      redoStack,
      canRedo: redoStack.length > 0,
      lastRedoDescription: redoStack.length > 0 ? redoStack[0].description : null,
    }),

  setCanUndo: (canUndo) => set({ canUndo }),

  setCanRedo: (canRedo) => set({ canRedo }),

  setProcessing: (isProcessing) => set({ isProcessing }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error, isProcessing: false }),

  setEnabled: (isEnabled) => set({ isEnabled }),

  clearStacks: () =>
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
      lastUndoDescription: null,
      lastRedoDescription: null,
    }),

  reset: () => set(initialState),

  getLastUndoEntry: () => {
    const state = get();
    return state.undoStack.length > 0 ? state.undoStack[0] : null;
  },

  getLastRedoEntry: () => {
    const state = get();
    return state.redoStack.length > 0 ? state.redoStack[0] : null;
  },

  getUndoCount: () => get().undoStack.length,

  getRedoCount: () => get().redoStack.length,
}));

// ============================================
// Async Actions (outside store for cleaner API)
// ============================================

/**
 * Check if undo feature is enabled
 */
export async function checkUndoEnabled(): Promise<boolean> {
  const store = useUndoStore.getState();

  try {
    const result = await window.electronAPI.isEnabled();
    if (result.success && result.data !== undefined) {
      store.setEnabled(result.data);
      return result.data;
    }
    return false;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to check undo status');
    return false;
  }
}

/**
 * Load the current undo/redo stack state
 */
export async function loadUndoStack(): Promise<void> {
  const store = useUndoStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getHistory();
    if (result.success && result.data) {
      store.setStackState(result.data);
    } else {
      store.setError(result.error || 'Failed to load undo stack');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading undo stack');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Perform an undo operation
 */
export async function performUndo(): Promise<UndoResult | null> {
  const store = useUndoStore.getState();

  if (!store.canUndo || store.isProcessing) {
    return null;
  }

  store.setProcessing(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.undo();

    if (result.success && result.data) {
      // Reload stack state after successful undo
      await loadUndoStack();
      return result.data;
    } else {
      store.setError(result.error || 'Undo operation failed');
      return {
        success: false,
        error: result.error || 'Undo operation failed',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during undo';
    store.setError(errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    store.setProcessing(false);
  }
}

/**
 * Perform a redo operation
 */
export async function performRedo(): Promise<UndoResult | null> {
  const store = useUndoStore.getState();

  if (!store.canRedo || store.isProcessing) {
    return null;
  }

  store.setProcessing(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.redo();

    if (result.success && result.data) {
      // Reload stack state after successful redo
      await loadUndoStack();
      return result.data;
    } else {
      store.setError(result.error || 'Redo operation failed');
      return {
        success: false,
        error: result.error || 'Redo operation failed',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during redo';
    store.setError(errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    store.setProcessing(false);
  }
}

/**
 * Clear undo/redo history
 */
export async function clearUndoHistory(options?: UndoClearOptions): Promise<boolean> {
  const store = useUndoStore.getState();
  store.setLoading(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.clearHistory(options);

    if (result.success) {
      store.clearStacks();
      return true;
    } else {
      store.setError(result.error || 'Failed to clear undo history');
      return false;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error clearing undo history');
    return false;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Check if undo is available
 */
export async function checkCanUndo(): Promise<boolean> {
  const store = useUndoStore.getState();

  try {
    const result = await window.electronAPI.canUndo();
    if (result.success && result.data !== undefined) {
      store.setCanUndo(result.data);
      return result.data;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if redo is available
 */
export async function checkCanRedo(): Promise<boolean> {
  const store = useUndoStore.getState();

  try {
    const result = await window.electronAPI.canRedo();
    if (result.success && result.data !== undefined) {
      store.setCanRedo(result.data);
      return result.data;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Initialize undo state and start listening for state changes
 */
export function initializeUndoStore(): () => void {
  // Load initial state
  checkUndoEnabled();
  loadUndoStack();

  // Subscribe to state changes from main process
  const unsubscribe = window.electronAPI.onStateChanged((state) => {
    useUndoStore.getState().setStackState(state);
  });

  return unsubscribe;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format undo operation type for display
 */
export function formatOperationType(type: string): string {
  switch (type) {
    case 'task_create':
      return 'Create Task';
    case 'task_delete':
      return 'Delete Task';
    case 'task_update':
      return 'Update Task';
    case 'task_status_change':
      return 'Change Status';
    case 'task_move':
      return 'Move Task';
    case 'batch':
      return 'Multiple Changes';
    default:
      return type;
  }
}

/**
 * Get icon name for operation type
 */
export function getOperationIcon(type: string): string {
  switch (type) {
    case 'task_create':
      return 'plus-circle';
    case 'task_delete':
      return 'trash';
    case 'task_update':
      return 'edit';
    case 'task_status_change':
      return 'refresh-cw';
    case 'task_move':
      return 'move';
    case 'batch':
      return 'layers';
    default:
      return 'circle';
  }
}

/**
 * Get color class for operation type
 */
export function getOperationColor(type: string): string {
  switch (type) {
    case 'task_create':
      return 'text-green-500';
    case 'task_delete':
      return 'text-red-500';
    case 'task_update':
      return 'text-blue-500';
    case 'task_status_change':
      return 'text-yellow-500';
    case 'task_move':
      return 'text-purple-500';
    case 'batch':
      return 'text-orange-500';
    default:
      return 'text-gray-500';
  }
}

/**
 * Format timestamp for display
 */
export function formatUndoTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Less than a minute ago
  if (diff < 60000) {
    return 'Just now';
  }

  // Less than an hour ago
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }

  // Less than a day ago
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }

  // Default to date string
  return date.toLocaleDateString();
}

/**
 * Generate a summary of the undo stack for display
 */
export function getUndoStackSummary(): string {
  const store = useUndoStore.getState();
  const undoCount = store.undoStack.length;
  const redoCount = store.redoStack.length;

  if (undoCount === 0 && redoCount === 0) {
    return 'No changes to undo or redo';
  }

  const parts: string[] = [];
  if (undoCount > 0) {
    parts.push(`${undoCount} undo${undoCount > 1 ? 's' : ''}`);
  }
  if (redoCount > 0) {
    parts.push(`${redoCount} redo${redoCount > 1 ? 's' : ''}`);
  }

  return parts.join(', ') + ' available';
}
