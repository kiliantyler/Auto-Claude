/**
 * Undo IPC Handlers
 * =================
 *
 * IPC handlers for undo/redo operations.
 * These handlers expose the UndoService to the renderer process.
 *
 * Available handlers:
 * - undo:undo - Undo the last operation
 * - undo:redo - Redo the last undone operation
 * - undo:get-stack - Get the current undo/redo stack state
 * - undo:is-enabled - Check if undo feature is enabled
 * - undo:push-operation - Push an operation to the stack
 * - undo:clear-stack - Clear the undo stack
 * - undo:start-session - Start a new undo session
 * - undo:get-session-id - Get the current session ID
 */

import { ipcMain } from 'electron';
import type {
  IPCResult,
  UndoResult,
  UndoStackState,
  UndoOperation,
  UndoPushOptions,
  UndoClearOptions,
  UndoStackEntry,
} from '../../shared/types';
import { getUndoService } from '../undo-service';

// IPC channel names for undo operations
export const UNDO_CHANNELS = {
  UNDO: 'undo:undo',
  REDO: 'undo:redo',
  GET_STACK: 'undo:get-stack',
  IS_ENABLED: 'undo:is-enabled',
  PUSH_OPERATION: 'undo:push-operation',
  CLEAR_STACK: 'undo:clear-stack',
  START_SESSION: 'undo:start-session',
  GET_SESSION_ID: 'undo:get-session-id',
} as const;

/**
 * Register undo IPC handlers
 *
 * Follows the same pattern as history-handlers.ts - simple registration function
 * that sets up all handlers when called.
 */
export function registerUndoHandlers(): void {
  console.log('[Undo Handlers] Registering undo IPC handlers');

  /**
   * Check if undo feature is enabled
   * Returns true if ENABLE_UNDO is not set to 'false'
   */
  ipcMain.handle(
    UNDO_CHANNELS.IS_ENABLED,
    async (): Promise<IPCResult<boolean>> => {
      try {
        const service = getUndoService();
        const enabled = service.isEnabled();
        return { success: true, data: enabled };
      } catch (error) {
        console.error('[Undo Handlers] Failed to check if undo is enabled:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check undo status',
        };
      }
    }
  );

  /**
   * Undo the last operation
   *
   * Retrieves the most recent operation from the undo stack,
   * executes its inverse operation, and moves the redo pointer.
   *
   * @returns UndoResult with success status and affected entry
   */
  ipcMain.handle(
    UNDO_CHANNELS.UNDO,
    async (): Promise<IPCResult<UndoResult>> => {
      console.log('[Undo Handlers] UNDO called');

      try {
        const service = getUndoService();
        const result = service.undo();

        if (result.success) {
          console.log('[Undo Handlers] UNDO succeeded:', result.entry?.description);
        } else {
          console.log('[Undo Handlers] UNDO failed:', result.error);
        }

        return { success: true, data: result };
      } catch (error) {
        console.error('[Undo Handlers] Failed to undo:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to undo',
        };
      }
    }
  );

  /**
   * Redo the last undone operation
   *
   * Retrieves the next operation after the current redo pointer,
   * executes the original operation, and moves the redo pointer forward.
   *
   * @returns UndoResult with success status and affected entry
   */
  ipcMain.handle(
    UNDO_CHANNELS.REDO,
    async (): Promise<IPCResult<UndoResult>> => {
      console.log('[Undo Handlers] REDO called');

      try {
        const service = getUndoService();
        const result = service.redo();

        if (result.success) {
          console.log('[Undo Handlers] REDO succeeded:', result.entry?.description);
        } else {
          console.log('[Undo Handlers] REDO failed:', result.error);
        }

        return { success: true, data: result };
      } catch (error) {
        console.error('[Undo Handlers] Failed to redo:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to redo',
        };
      }
    }
  );

  /**
   * Get the current undo/redo stack state
   *
   * Returns information about available undo/redo operations
   * for UI display and keyboard shortcut availability.
   *
   * @returns UndoStackState with undo/redo stacks and availability flags
   */
  ipcMain.handle(
    UNDO_CHANNELS.GET_STACK,
    async (): Promise<IPCResult<UndoStackState>> => {
      console.log('[Undo Handlers] GET_STACK called');

      try {
        const service = getUndoService();
        const state = service.getStack();
        console.log(
          '[Undo Handlers] GET_STACK returning',
          state.undoStack.length,
          'undo entries,',
          state.redoStack.length,
          'redo entries'
        );
        return { success: true, data: state };
      } catch (error) {
        console.error('[Undo Handlers] Failed to get stack:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get undo stack',
        };
      }
    }
  );

  /**
   * Push an operation to the undo stack
   *
   * Use this to record an operation that can be undone.
   * Typically called from task CRUD operations.
   *
   * @param operation - The operation that was performed
   * @param inverseOperation - The operation to perform to undo
   * @param options - Optional push options (sessionId, description)
   * @returns UndoStackEntry or null if push failed
   */
  ipcMain.handle(
    UNDO_CHANNELS.PUSH_OPERATION,
    async (
      _,
      operation: UndoOperation,
      inverseOperation: UndoOperation,
      options?: UndoPushOptions
    ): Promise<IPCResult<UndoStackEntry | null>> => {
      console.log('[Undo Handlers] PUSH_OPERATION called:', options?.description);

      if (!operation || !operation.type || !operation.taskId) {
        return { success: false, error: 'Invalid operation: missing type or taskId' };
      }

      if (!inverseOperation || !inverseOperation.type || !inverseOperation.taskId) {
        return { success: false, error: 'Invalid inverse operation: missing type or taskId' };
      }

      try {
        const service = getUndoService();
        const entry = service.pushOperation(operation, inverseOperation, options);

        if (entry) {
          console.log('[Undo Handlers] PUSH_OPERATION succeeded:', entry.description);
        } else {
          console.log('[Undo Handlers] PUSH_OPERATION returned null (feature disabled?)');
        }

        return { success: true, data: entry };
      } catch (error) {
        console.error('[Undo Handlers] Failed to push operation:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to push operation',
        };
      }
    }
  );

  /**
   * Clear the undo stack
   *
   * Removes entries from the undo stack based on options.
   *
   * @param options - Clear options (sessionId, olderThan, all)
   * @returns Number of entries cleared
   */
  ipcMain.handle(
    UNDO_CHANNELS.CLEAR_STACK,
    async (_, options?: UndoClearOptions): Promise<IPCResult<number>> => {
      console.log('[Undo Handlers] CLEAR_STACK called with options:', options);

      try {
        const service = getUndoService();
        const count = service.clearStack(options);
        console.log('[Undo Handlers] CLEAR_STACK cleared', count, 'entries');
        return { success: true, data: count };
      } catch (error) {
        console.error('[Undo Handlers] Failed to clear stack:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear undo stack',
        };
      }
    }
  );

  /**
   * Start a new undo session
   *
   * Creates a new session ID for grouping related operations.
   *
   * @returns New session ID
   */
  ipcMain.handle(
    UNDO_CHANNELS.START_SESSION,
    async (): Promise<IPCResult<string>> => {
      console.log('[Undo Handlers] START_SESSION called');

      try {
        const service = getUndoService();
        const sessionId = service.startNewSession();
        console.log('[Undo Handlers] START_SESSION created session:', sessionId);
        return { success: true, data: sessionId };
      } catch (error) {
        console.error('[Undo Handlers] Failed to start session:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start undo session',
        };
      }
    }
  );

  /**
   * Get the current session ID
   *
   * @returns Current session ID
   */
  ipcMain.handle(
    UNDO_CHANNELS.GET_SESSION_ID,
    async (): Promise<IPCResult<string>> => {
      console.log('[Undo Handlers] GET_SESSION_ID called');

      try {
        const service = getUndoService();
        const sessionId = service.getSessionId();
        console.log('[Undo Handlers] GET_SESSION_ID returning:', sessionId);
        return { success: true, data: sessionId };
      } catch (error) {
        console.error('[Undo Handlers] Failed to get session ID:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session ID',
        };
      }
    }
  );

  console.log('[Undo Handlers] All undo IPC handlers registered successfully');
}
