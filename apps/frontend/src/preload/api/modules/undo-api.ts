import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  UndoResult,
  UndoStackState,
  UndoClearOptions,
  IPCResult
} from '../../../shared/types';
import { invokeIpc, createIpcListener } from './ipc-utils';

/**
 * Undo/Redo API operations for task change history
 * Phase 4C - Undo/Redo System
 */
export interface UndoAPI {
  // Core Undo/Redo Operations
  undo: () => Promise<IPCResult<UndoResult>>;
  redo: () => Promise<IPCResult<UndoResult>>;

  // State Queries
  canUndo: () => Promise<IPCResult<boolean>>;
  canRedo: () => Promise<IPCResult<boolean>>;
  getHistory: () => Promise<IPCResult<UndoStackState>>;

  // History Management
  clearHistory: (options?: UndoClearOptions) => Promise<IPCResult<void>>;

  // Feature Flag
  isEnabled: () => Promise<IPCResult<boolean>>;

  // Event Listeners
  onStateChanged: (callback: (state: UndoStackState) => void) => () => void;
}

/**
 * Creates the Undo API implementation
 */
export const createUndoAPI = (): UndoAPI => ({
  // Core Undo/Redo Operations
  undo: (): Promise<IPCResult<UndoResult>> =>
    invokeIpc(IPC_CHANNELS.UNDO_UNDO),

  redo: (): Promise<IPCResult<UndoResult>> =>
    invokeIpc(IPC_CHANNELS.UNDO_REDO),

  // State Queries
  canUndo: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.UNDO_CAN_UNDO),

  canRedo: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.UNDO_CAN_REDO),

  getHistory: (): Promise<IPCResult<UndoStackState>> =>
    invokeIpc(IPC_CHANNELS.UNDO_GET_HISTORY),

  // History Management
  clearHistory: (options?: UndoClearOptions): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.UNDO_CLEAR_HISTORY, options),

  // Feature Flag
  isEnabled: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.UNDO_IS_ENABLED),

  // Event Listeners
  onStateChanged: (callback: (state: UndoStackState) => void): (() => void) =>
    createIpcListener<[UndoStackState]>(IPC_CHANNELS.UNDO_STATE_CHANGED, callback)
});
