/**
 * Undo Service - Undo/Redo Stack Management
 * ==========================================
 *
 * Provides undo/redo functionality for task operations using the undo_stack database table.
 * Operations are stored as JSON-serialized action objects with their inverse operations.
 *
 * Key Features:
 * - Push operations to undo stack (pushOperation)
 * - Undo last operation (undo)
 * - Redo last undone operation (redo)
 * - Get current stack state (getStack)
 * - Session-based operation grouping
 * - Configurable stack size limit (default: 50)
 * - Feature flag support (ENABLE_UNDO)
 *
 * Usage:
 * ```typescript
 * const service = getUndoService();
 *
 * // Push an operation
 * service.pushOperation(operation, inverseOperation, {
 *   sessionId: 'my-session',
 *   description: 'Update task title',
 * });
 *
 * // Undo last operation
 * const result = service.undo();
 *
 * // Redo last undone operation
 * const result = service.redo();
 *
 * // Get current stack state
 * const state = service.getStack();
 * ```
 */

import type {
  UndoOperation,
  UndoStackEntry,
  DatabaseUndoRow,
  UndoResult,
  UndoPushOptions,
  UndoStackState,
  UndoClearOptions,
  UndoConfig,
  TaskCreateData,
  TaskUpdateData,
  TaskStatusChangeData,
  TaskMoveData,
  BatchOperationData,
} from '../shared/types';
import { DEFAULT_UNDO_CONFIG, generateOperationDescription } from '../shared/types';
import { getDatabaseConnection } from './database';
import { getTaskStorage } from './task-storage';

/**
 * Generate a unique session ID for grouping operations
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Undo Service
 * Handles undo/redo stack management with SQLite database
 */
export class UndoService {
  private readonly ENABLE_UNDO: boolean;
  private readonly config: UndoConfig;
  private currentSessionId: string;
  private redoPointer: number; // Points to the current position in the stack for redo operations

  constructor() {
    // Enable undo/redo by default
    // Set ENABLE_UNDO=false to disable undo/redo features
    this.ENABLE_UNDO = process.env.ENABLE_UNDO !== 'false';
    this.config = { ...DEFAULT_UNDO_CONFIG };
    this.currentSessionId = generateSessionId();
    this.redoPointer = -1; // No redo available initially

    console.log(`[UndoService] Undo/redo feature: ${this.ENABLE_UNDO ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Check if undo/redo feature is enabled
   *
   * @returns true if undo/redo feature is enabled
   */
  isEnabled(): boolean {
    return this.ENABLE_UNDO;
  }

  /**
   * Get the current session ID
   *
   * @returns Current session ID string
   */
  getSessionId(): string {
    return this.currentSessionId;
  }

  /**
   * Start a new session
   *
   * Creates a new session ID and resets the redo pointer.
   * Use this when starting a new editing session.
   *
   * @returns New session ID
   */
  startNewSession(): string {
    this.currentSessionId = generateSessionId();
    this.redoPointer = -1;
    return this.currentSessionId;
  }

  /**
   * Push an operation onto the undo stack
   *
   * @param operation - The operation that was performed
   * @param inverseOperation - The operation to perform to undo
   * @param options - Optional push options (sessionId, description)
   * @returns UndoStackEntry or null if push failed
   */
  pushOperation(
    operation: UndoOperation,
    inverseOperation: UndoOperation,
    options?: UndoPushOptions
  ): UndoStackEntry | null {
    if (!this.ENABLE_UNDO) {
      return null;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const sessionId = options?.sessionId ?? this.currentSessionId;
      const description = options?.description ?? generateOperationDescription(operation);

      // Get the next sequence number for this session
      const maxSeqStmt = db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) as max_seq
        FROM undo_stack
        WHERE session_id = ?
      `);
      const maxSeqResult = maxSeqStmt.get(sessionId) as { max_seq: number };
      const nextSequence = maxSeqResult.max_seq + 1;

      // When pushing a new operation, clear any redo entries
      // (entries with sequence > current redo pointer in same session)
      if (this.redoPointer >= 0) {
        const clearRedoStmt = db.prepare(`
          DELETE FROM undo_stack
          WHERE session_id = ? AND sequence > ?
        `);
        clearRedoStmt.run(sessionId, this.redoPointer);
      }

      // Enforce max stack size - remove oldest entries if needed
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM undo_stack WHERE session_id = ?');
      const countResult = countStmt.get(sessionId) as { count: number };

      if (countResult.count >= this.config.maxStackSize) {
        // Remove oldest entries to make room
        const entriesToRemove = countResult.count - this.config.maxStackSize + 1;
        const removeStmt = db.prepare(`
          DELETE FROM undo_stack
          WHERE session_id = ? AND id IN (
            SELECT id FROM undo_stack
            WHERE session_id = ?
            ORDER BY sequence ASC
            LIMIT ?
          )
        `);
        removeStmt.run(sessionId, sessionId, entriesToRemove);
      }

      // Insert the new operation
      const insertStmt = db.prepare(`
        INSERT INTO undo_stack (session_id, sequence, operation, inverse_operation, description)
        VALUES (?, ?, ?, ?, ?)
      `);

      const operationJson = JSON.stringify(operation);
      const inverseJson = JSON.stringify(inverseOperation);

      const result = insertStmt.run(sessionId, nextSequence, operationJson, inverseJson, description);

      // Update redo pointer to point to the new entry
      this.redoPointer = nextSequence;

      // Get the inserted entry
      const entry = this.getEntryById(Number(result.lastInsertRowid));

      console.log(`[UndoService] Pushed operation: ${description} (seq: ${nextSequence})`);

      return entry;
    } catch (error) {
      console.error('[UndoService] Failed to push operation:', error);
      return null;
    }
  }

  /**
   * Undo the last operation
   *
   * Retrieves the most recent operation from the undo stack,
   * executes its inverse operation, and moves the redo pointer.
   *
   * @returns UndoResult with success status and affected entry
   */
  undo(): UndoResult {
    if (!this.ENABLE_UNDO) {
      return { success: false, error: 'Undo feature is disabled' };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Get the last undoable entry (at or before the redo pointer)
      const stmt = db.prepare(`
        SELECT * FROM undo_stack
        WHERE session_id = ? AND sequence <= ?
        ORDER BY sequence DESC
        LIMIT 1
      `);

      // If redo pointer is -1 (fresh session), get the latest entry
      const effectivePointer = this.redoPointer === -1 ? 999999999 : this.redoPointer;
      const row = stmt.get(this.currentSessionId, effectivePointer) as DatabaseUndoRow | undefined;

      if (!row) {
        return { success: false, error: 'Nothing to undo' };
      }

      const entry = this.rowToEntry(row);

      // Execute the inverse operation
      const executeResult = this.executeOperation(entry.inverseOperation);
      if (!executeResult.success) {
        return executeResult;
      }

      // Move redo pointer back
      this.redoPointer = row.sequence - 1;

      console.log(`[UndoService] Undo: ${entry.description} (seq: ${row.sequence})`);

      return {
        success: true,
        entry,
        affectedTaskId: entry.inverseOperation.taskId,
      };
    } catch (error) {
      console.error('[UndoService] Failed to undo:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Redo the last undone operation
   *
   * Retrieves the next operation after the current redo pointer,
   * executes the original operation, and moves the redo pointer forward.
   *
   * @returns UndoResult with success status and affected entry
   */
  redo(): UndoResult {
    if (!this.ENABLE_UNDO) {
      return { success: false, error: 'Undo feature is disabled' };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Get the next redoable entry (after the redo pointer)
      const stmt = db.prepare(`
        SELECT * FROM undo_stack
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT 1
      `);

      const row = stmt.get(this.currentSessionId, this.redoPointer) as DatabaseUndoRow | undefined;

      if (!row) {
        return { success: false, error: 'Nothing to redo' };
      }

      const entry = this.rowToEntry(row);

      // Execute the original operation (to redo)
      const executeResult = this.executeOperation(entry.operation);
      if (!executeResult.success) {
        return executeResult;
      }

      // Move redo pointer forward
      this.redoPointer = row.sequence;

      console.log(`[UndoService] Redo: ${entry.description} (seq: ${row.sequence})`);

      return {
        success: true,
        entry,
        affectedTaskId: entry.operation.taskId,
      };
    } catch (error) {
      console.error('[UndoService] Failed to redo:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get the current state of the undo/redo stack
   *
   * Returns information about available undo/redo operations
   * for UI display and keyboard shortcut availability.
   *
   * @returns UndoStackState with undo/redo stacks and availability
   */
  getStack(): UndoStackState {
    if (!this.ENABLE_UNDO) {
      return {
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        isProcessing: false,
      };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Get entries that can be undone (at or before redo pointer)
      const effectivePointer = this.redoPointer === -1 ? 999999999 : this.redoPointer;
      const undoStmt = db.prepare(`
        SELECT * FROM undo_stack
        WHERE session_id = ? AND sequence <= ?
        ORDER BY sequence DESC
      `);
      const undoRows = undoStmt.all(this.currentSessionId, effectivePointer) as DatabaseUndoRow[];
      const undoStack = undoRows.map((row) => this.rowToEntry(row));

      // Get entries that can be redone (after redo pointer)
      const redoStmt = db.prepare(`
        SELECT * FROM undo_stack
        WHERE session_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `);
      const redoRows = redoStmt.all(this.currentSessionId, this.redoPointer) as DatabaseUndoRow[];
      const redoStack = redoRows.map((row) => this.rowToEntry(row));

      return {
        undoStack,
        redoStack,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        isProcessing: false,
        lastUndoDescription: undoStack[0]?.description,
        lastRedoDescription: redoStack[0]?.description,
      };
    } catch (error) {
      console.error('[UndoService] Failed to get stack:', error);
      return {
        undoStack: [],
        redoStack: [],
        canUndo: false,
        canRedo: false,
        isProcessing: false,
      };
    }
  }

  /**
   * Clear the undo stack
   *
   * @param options - Clear options (sessionId, olderThan, all)
   * @returns Number of entries cleared
   */
  clearStack(options?: UndoClearOptions): number {
    if (!this.ENABLE_UNDO) {
      return 0;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      let stmt;
      let result;

      if (options?.all) {
        // Clear all entries
        stmt = db.prepare('DELETE FROM undo_stack');
        result = stmt.run();
      } else if (options?.sessionId) {
        // Clear entries for specific session
        stmt = db.prepare('DELETE FROM undo_stack WHERE session_id = ?');
        result = stmt.run(options.sessionId);
      } else if (options?.olderThan) {
        // Clear entries older than timestamp
        stmt = db.prepare('DELETE FROM undo_stack WHERE timestamp < ?');
        result = stmt.run(options.olderThan);
      } else {
        // Clear current session by default
        stmt = db.prepare('DELETE FROM undo_stack WHERE session_id = ?');
        result = stmt.run(this.currentSessionId);
      }

      // Reset redo pointer if clearing current session
      if (!options?.sessionId || options.sessionId === this.currentSessionId) {
        this.redoPointer = -1;
      }

      console.log(`[UndoService] Cleared ${result.changes} entries`);

      return result.changes;
    } catch (error) {
      console.error('[UndoService] Failed to clear stack:', error);
      return 0;
    }
  }

  /**
   * Clean up old sessions (older than session timeout)
   *
   * @returns Number of entries cleaned up
   */
  cleanupOldSessions(): number {
    if (!this.ENABLE_UNDO) {
      return 0;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const cutoffTime = new Date(Date.now() - this.config.sessionTimeoutMs).toISOString();

      const stmt = db.prepare('DELETE FROM undo_stack WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);

      if (result.changes > 0) {
        console.log(`[UndoService] Cleaned up ${result.changes} old entries`);
      }

      return result.changes;
    } catch (error) {
      console.error('[UndoService] Failed to cleanup old sessions:', error);
      return 0;
    }
  }

  /**
   * Get an entry by its database ID
   *
   * @param id - Entry ID
   * @returns UndoStackEntry or null if not found
   */
  private getEntryById(id: number): UndoStackEntry | null {
    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare('SELECT * FROM undo_stack WHERE id = ?');
      const row = stmt.get(id) as DatabaseUndoRow | undefined;

      if (!row) {
        return null;
      }

      return this.rowToEntry(row);
    } catch (error) {
      console.error(`[UndoService] Failed to get entry by ID ${id}:`, error);
      return null;
    }
  }

  /**
   * Execute an undo operation
   *
   * This method dispatches the operation to the appropriate handler
   * based on the operation type.
   *
   * @param operation - The operation to execute
   * @returns UndoResult indicating success or failure
   */
  private executeOperation(operation: UndoOperation): UndoResult {
    // Import task storage for executing operations
    const taskStorage = getTaskStorage();

    try {
      switch (operation.type) {
        case 'task_create':
          return this.executeTaskCreate(operation);

        case 'task_delete':
          return this.executeTaskDelete(operation);

        case 'task_update':
          return this.executeTaskUpdate(operation);

        case 'task_status_change':
          return this.executeTaskStatusChange(operation);

        case 'task_move':
          return this.executeTaskMove(operation);

        case 'batch':
          return this.executeBatch(operation);

        default:
          return { success: false, error: `Unknown operation type: ${operation.type}` };
      }
    } catch (error) {
      console.error('[UndoService] Failed to execute operation:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Execute a task create operation (recreate a task)
   */
  private executeTaskCreate(operation: UndoOperation): UndoResult {
    const taskStorage = getTaskStorage();
    const data = operation.data as TaskCreateData;

    try {
      // Create the task from snapshot
      const task = taskStorage.createTask({
        id: data.taskSnapshot.id,
        specId: data.taskSnapshot.specId,
        projectId: data.taskSnapshot.projectId,
        title: data.taskSnapshot.title,
        description: data.taskSnapshot.description,
        status: data.taskSnapshot.status,
        metadata: data.taskSnapshot.metadataJson ? JSON.parse(data.taskSnapshot.metadataJson) : undefined,
        createdAt: new Date(data.taskSnapshot.createdAt),
        updatedAt: new Date(data.taskSnapshot.updatedAt),
        subtasks: [],
        logs: [],
      });

      return { success: true, affectedTaskId: task.id };
    } catch (error) {
      return { success: false, error: `Failed to create task: ${error}` };
    }
  }

  /**
   * Execute a task delete operation
   */
  private executeTaskDelete(operation: UndoOperation): UndoResult {
    const taskStorage = getTaskStorage();

    try {
      const deleted = taskStorage.deleteTask(operation.taskId);
      if (!deleted) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }
      return { success: true, affectedTaskId: operation.taskId };
    } catch (error) {
      return { success: false, error: `Failed to delete task: ${error}` };
    }
  }

  /**
   * Execute a task update operation
   */
  private executeTaskUpdate(operation: UndoOperation): UndoResult {
    const taskStorage = getTaskStorage();
    const data = operation.data as TaskUpdateData;

    try {
      const updated = taskStorage.updateTask(operation.taskId, {
        [data.fieldName]: data.newValue,
      });

      if (!updated) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      return { success: true, affectedTaskId: operation.taskId };
    } catch (error) {
      return { success: false, error: `Failed to update task: ${error}` };
    }
  }

  /**
   * Execute a task status change operation
   */
  private executeTaskStatusChange(operation: UndoOperation): UndoResult {
    const taskStorage = getTaskStorage();
    const data = operation.data as TaskStatusChangeData;

    try {
      const updated = taskStorage.updateTask(operation.taskId, {
        status: data.newStatus,
      });

      if (!updated) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      return { success: true, affectedTaskId: operation.taskId };
    } catch (error) {
      return { success: false, error: `Failed to change task status: ${error}` };
    }
  }

  /**
   * Execute a task move operation
   */
  private executeTaskMove(operation: UndoOperation): UndoResult {
    const taskStorage = getTaskStorage();
    const data = operation.data as TaskMoveData;

    try {
      const updated = taskStorage.updateTask(operation.taskId, {
        projectId: data.newProjectId,
      });

      if (!updated) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      return { success: true, affectedTaskId: operation.taskId };
    } catch (error) {
      return { success: false, error: `Failed to move task: ${error}` };
    }
  }

  /**
   * Execute a batch of operations
   */
  private executeBatch(operation: UndoOperation): UndoResult {
    const data = operation.data as BatchOperationData;
    const results: UndoResult[] = [];

    // Execute each operation in the batch
    for (const op of data.operations) {
      const result = this.executeOperation(op);
      results.push(result);

      // If any operation fails, return the error
      if (!result.success) {
        return result;
      }
    }

    return {
      success: true,
      affectedTaskId: data.operations[0]?.taskId,
    };
  }

  /**
   * Convert database row to UndoStackEntry object
   *
   * @param row - Database row from undo_stack table
   * @returns UndoStackEntry object
   */
  private rowToEntry(row: DatabaseUndoRow): UndoStackEntry {
    return {
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      operation: JSON.parse(row.operation) as UndoOperation,
      inverseOperation: JSON.parse(row.inverse_operation) as UndoOperation,
      timestamp: row.timestamp,
      description: row.description || 'Unknown operation',
    };
  }
}

// Singleton instance
let _instance: UndoService | null = null;

/**
 * Get the singleton UndoService instance
 *
 * @returns UndoService instance
 */
export function getUndoService(): UndoService {
  if (!_instance) {
    _instance = new UndoService();
  }
  return _instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetUndoService(): void {
  _instance = null;
}
