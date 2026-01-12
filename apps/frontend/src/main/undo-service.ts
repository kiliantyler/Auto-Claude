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
 * - Automatic inverse operation generation for all operation types
 *
 * Supported Operation Types:
 * - task_create: Create a new task (inverse: delete)
 * - task_delete: Delete a task (inverse: create from snapshot)
 * - task_update: Update a task field (inverse: swap old/new values)
 * - task_status_change: Change task status (inverse: swap old/new status)
 * - task_move: Move task between projects (inverse: swap project IDs)
 * - batch: Multiple operations together (inverse: reversed, inverted batch)
 *
 * Usage - Basic (manual operation/inverse):
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
 *
 * Usage - With Convenience Methods (automatic inverse generation):
 * ```typescript
 * const service = getUndoService();
 *
 * // Record task creation
 * const task = taskStorage.createTask(newTask);
 * service.recordTaskCreate(task);
 *
 * // Record task deletion (call BEFORE deleting)
 * const task = taskStorage.getTask(taskId);
 * service.recordTaskDelete(task);
 * taskStorage.deleteTask(taskId);
 *
 * // Record task update
 * const oldTitle = task.title;
 * taskStorage.updateTask(task.id, { title: 'New Title' });
 * service.recordTaskUpdate(task.id, 'title', oldTitle, 'New Title');
 *
 * // Record status change
 * service.recordStatusChange(task.id, 'backlog', 'in_progress');
 *
 * // Record task move
 * service.recordTaskMove(task.id, oldProjectId, newProjectId);
 * ```
 *
 * Usage - Helper Functions (for custom integration):
 * ```typescript
 * import {
 *   createInverseOperation,
 *   createTaskCreateOperationPair,
 *   createTaskDeleteOperationPair,
 *   createTaskUpdateOperationPair,
 *   createTaskStatusChangeOperationPair,
 *   createTaskMoveOperationPair,
 *   createBatchOperationPair,
 *   createTaskSnapshot,
 * } from './undo-service';
 *
 * // Generate inverse automatically
 * const { operation, inverseOperation } = createTaskUpdateOperationPair(
 *   taskId, 'title', 'Old Title', 'New Title'
 * );
 *
 * // Or invert an existing operation
 * const inverse = createInverseOperation(someOperation);
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
  TaskDeleteData,
  TaskStatusChangeData,
  TaskMoveData,
  BatchOperationData,
  TaskSnapshot,
  Task,
  TaskStatus,
} from '../shared/types';
import { DEFAULT_UNDO_CONFIG, generateOperationDescription } from '../shared/types';
import { getGlobalDatabase } from './database';
import { getProjectTaskStorage } from './task-storage';
import { projectStore } from './project-store';

// ============================================================================
// Inverse Operation Generation Helpers
// ============================================================================

/**
 * Create the inverse of any UndoOperation
 *
 * This is the core function that generates an inverse operation for any
 * supported operation type. The inverse operation is what gets executed
 * when the user performs an "undo".
 *
 * @param operation - The operation to create an inverse for
 * @returns The inverse operation
 *
 * @example
 * ```typescript
 * const createOp = { type: 'task_create', taskId: 'task-1', data: { taskSnapshot } };
 * const inverseOp = createInverseOperation(createOp);
 * // inverseOp = { type: 'task_delete', taskId: 'task-1', data: { taskSnapshot } }
 * ```
 */
export function createInverseOperation(operation: UndoOperation): UndoOperation {
  switch (operation.type) {
    case 'task_create': {
      // Inverse of create is delete (with same snapshot for potential re-creation)
      const data = operation.data as TaskCreateData;
      return {
        type: 'task_delete',
        taskId: operation.taskId,
        data: {
          taskSnapshot: data.taskSnapshot,
        } as TaskDeleteData,
      };
    }

    case 'task_delete': {
      // Inverse of delete is create (recreate from snapshot)
      const data = operation.data as TaskDeleteData;
      return {
        type: 'task_create',
        taskId: operation.taskId,
        data: {
          taskSnapshot: data.taskSnapshot,
        } as TaskCreateData,
      };
    }

    case 'task_update': {
      // Inverse of update is update with swapped old/new values
      const data = operation.data as TaskUpdateData;
      return {
        type: 'task_update',
        taskId: operation.taskId,
        data: {
          fieldName: data.fieldName,
          oldValue: data.newValue, // Swap: new becomes old
          newValue: data.oldValue, // Swap: old becomes new
        } as TaskUpdateData,
      };
    }

    case 'task_status_change': {
      // Inverse of status change is status change with swapped statuses
      const data = operation.data as TaskStatusChangeData;
      return {
        type: 'task_status_change',
        taskId: operation.taskId,
        data: {
          oldStatus: data.newStatus, // Swap: new becomes old
          newStatus: data.oldStatus, // Swap: old becomes new
        } as TaskStatusChangeData,
      };
    }

    case 'task_move': {
      // Inverse of move is move with swapped project IDs
      const data = operation.data as TaskMoveData;
      return {
        type: 'task_move',
        taskId: operation.taskId,
        data: {
          oldProjectId: data.newProjectId, // Swap: new becomes old
          newProjectId: data.oldProjectId, // Swap: old becomes new
          oldPosition: data.newPosition,
          newPosition: data.oldPosition,
        } as TaskMoveData,
      };
    }

    case 'batch': {
      // Inverse of batch is batch with reversed operations (each inverted)
      const data = operation.data as BatchOperationData;
      const invertedOps = data.operations
        .map((op) => createInverseOperation(op))
        .reverse(); // Reverse order for correct undo sequence
      return {
        type: 'batch',
        taskId: operation.taskId,
        data: {
          operations: invertedOps,
        } as BatchOperationData,
      };
    }

    default:
      throw new Error(`Cannot create inverse for unknown operation type: ${operation.type}`);
  }
}

/**
 * Create a task snapshot from a Task object
 *
 * Extracts the essential fields needed to recreate a task.
 *
 * @param task - The task to snapshot
 * @returns TaskSnapshot with serialized data
 */
export function createTaskSnapshot(task: Task): TaskSnapshot {
  return {
    id: task.id,
    specId: task.specId,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    metadataJson: task.metadata ? JSON.stringify(task.metadata) : undefined,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
  };
}

/**
 * Create a task_create operation with automatic inverse generation
 *
 * Use this when a new task is created. The inverse is a delete operation.
 *
 * @param task - The task that was created
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const task = await taskStorage.createTask(newTaskData);
 * const { operation, inverseOperation } = createTaskCreateOperationPair(task);
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createTaskCreateOperationPair(task: Task): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const snapshot = createTaskSnapshot(task);
  const operation: UndoOperation = {
    type: 'task_create',
    taskId: task.id,
    data: {
      taskSnapshot: snapshot,
    } as TaskCreateData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

/**
 * Create a task_delete operation with automatic inverse generation
 *
 * Use this before deleting a task. The inverse is a create operation
 * that will restore the task from its snapshot.
 *
 * @param task - The task that will be/was deleted
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const task = taskStorage.getTask(taskId);
 * const { operation, inverseOperation } = createTaskDeleteOperationPair(task);
 * taskStorage.deleteTask(taskId);
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createTaskDeleteOperationPair(task: Task): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const snapshot = createTaskSnapshot(task);
  const operation: UndoOperation = {
    type: 'task_delete',
    taskId: task.id,
    data: {
      taskSnapshot: snapshot,
    } as TaskDeleteData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

/**
 * Create a task_update operation with automatic inverse generation
 *
 * Use this when updating a task field. The inverse swaps old/new values.
 *
 * @param taskId - The ID of the task being updated
 * @param fieldName - The name of the field being updated
 * @param oldValue - The previous value
 * @param newValue - The new value
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const oldTitle = task.title;
 * task.title = 'New Title';
 * const { operation, inverseOperation } = createTaskUpdateOperationPair(
 *   task.id, 'title', oldTitle, task.title
 * );
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createTaskUpdateOperationPair(
  taskId: string,
  fieldName: string,
  oldValue: unknown,
  newValue: unknown
): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const operation: UndoOperation = {
    type: 'task_update',
    taskId,
    data: {
      fieldName,
      oldValue,
      newValue,
    } as TaskUpdateData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

/**
 * Create a task_status_change operation with automatic inverse generation
 *
 * Use this when changing a task's status. The inverse swaps old/new statuses.
 *
 * @param taskId - The ID of the task
 * @param oldStatus - The previous status
 * @param newStatus - The new status
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const oldStatus = task.status;
 * task.status = 'completed';
 * const { operation, inverseOperation } = createTaskStatusChangeOperationPair(
 *   task.id, oldStatus, task.status
 * );
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createTaskStatusChangeOperationPair(
  taskId: string,
  oldStatus: TaskStatus,
  newStatus: TaskStatus
): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const operation: UndoOperation = {
    type: 'task_status_change',
    taskId,
    data: {
      oldStatus,
      newStatus,
    } as TaskStatusChangeData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

/**
 * Create a task_move operation with automatic inverse generation
 *
 * Use this when moving a task between projects. The inverse swaps project IDs.
 *
 * @param taskId - The ID of the task
 * @param oldProjectId - The previous project ID
 * @param newProjectId - The new project ID
 * @param oldPosition - Optional previous position in the column
 * @param newPosition - Optional new position in the column
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const oldProjectId = task.projectId;
 * task.projectId = newProjectId;
 * const { operation, inverseOperation } = createTaskMoveOperationPair(
 *   task.id, oldProjectId, newProjectId
 * );
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createTaskMoveOperationPair(
  taskId: string,
  oldProjectId: string,
  newProjectId: string,
  oldPosition?: number,
  newPosition?: number
): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const operation: UndoOperation = {
    type: 'task_move',
    taskId,
    data: {
      oldProjectId,
      newProjectId,
      oldPosition,
      newPosition,
    } as TaskMoveData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

/**
 * Create a batch operation with automatic inverse generation
 *
 * Use this when performing multiple operations atomically.
 * The inverse reverses and inverts all operations.
 *
 * @param operations - Array of operations to batch
 * @param primaryTaskId - The ID of the primary task (for reference)
 * @returns Object with operation and inverseOperation
 *
 * @example
 * ```typescript
 * const ops = [
 *   createTaskUpdateOperationPair(task1.id, 'title', 'Old1', 'New1').operation,
 *   createTaskUpdateOperationPair(task2.id, 'title', 'Old2', 'New2').operation,
 * ];
 * const { operation, inverseOperation } = createBatchOperationPair(ops, task1.id);
 * undoService.pushOperation(operation, inverseOperation);
 * ```
 */
export function createBatchOperationPair(
  operations: UndoOperation[],
  primaryTaskId: string
): {
  operation: UndoOperation;
  inverseOperation: UndoOperation;
} {
  const operation: UndoOperation = {
    type: 'batch',
    taskId: primaryTaskId,
    data: {
      operations,
    } as BatchOperationData,
  };

  return {
    operation,
    inverseOperation: createInverseOperation(operation),
  };
}

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
      const db = getGlobalDatabase().getConnection();

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
      const db = getGlobalDatabase().getConnection();

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
      const db = getGlobalDatabase().getConnection();

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
      const db = getGlobalDatabase().getConnection();

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
      const db = getGlobalDatabase().getConnection();

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
      const db = getGlobalDatabase().getConnection();

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

  // ============================================================================
  // Convenience Methods - Push with Automatic Inverse Generation
  // ============================================================================

  /**
   * Record a task creation for undo
   *
   * Automatically generates the inverse operation (delete) and pushes to stack.
   *
   * @param task - The task that was created
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const task = taskStorage.createTask(newTaskData);
   * undoService.recordTaskCreate(task);
   * ```
   */
  recordTaskCreate(task: Task, options?: UndoPushOptions): UndoStackEntry | null {
    const { operation, inverseOperation } = createTaskCreateOperationPair(task);
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? `Create task "${task.title}"`,
    });
  }

  /**
   * Record a task deletion for undo
   *
   * Automatically generates the inverse operation (create from snapshot) and pushes to stack.
   * Call this BEFORE deleting the task so the snapshot is captured correctly.
   *
   * @param task - The task that will be deleted (with full data for restoration)
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const task = taskStorage.getTask(taskId);
   * undoService.recordTaskDelete(task);
   * taskStorage.deleteTask(taskId);
   * ```
   */
  recordTaskDelete(task: Task, options?: UndoPushOptions): UndoStackEntry | null {
    const { operation, inverseOperation } = createTaskDeleteOperationPair(task);
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? `Delete task "${task.title}"`,
    });
  }

  /**
   * Record a task field update for undo
   *
   * Automatically generates the inverse operation and pushes to stack.
   *
   * @param taskId - The ID of the task being updated
   * @param fieldName - The name of the field being updated
   * @param oldValue - The previous value
   * @param newValue - The new value
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const oldTitle = task.title;
   * taskStorage.updateTask(task.id, { title: 'New Title' });
   * undoService.recordTaskUpdate(task.id, 'title', oldTitle, 'New Title');
   * ```
   */
  recordTaskUpdate(
    taskId: string,
    fieldName: string,
    oldValue: unknown,
    newValue: unknown,
    options?: UndoPushOptions
  ): UndoStackEntry | null {
    const { operation, inverseOperation } = createTaskUpdateOperationPair(
      taskId,
      fieldName,
      oldValue,
      newValue
    );
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? `Update ${fieldName}`,
    });
  }

  /**
   * Record a task status change for undo
   *
   * Automatically generates the inverse operation and pushes to stack.
   *
   * @param taskId - The ID of the task
   * @param oldStatus - The previous status
   * @param newStatus - The new status
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const oldStatus = task.status;
   * taskStorage.updateTask(task.id, { status: 'completed' });
   * undoService.recordStatusChange(task.id, oldStatus, 'completed');
   * ```
   */
  recordStatusChange(
    taskId: string,
    oldStatus: TaskStatus,
    newStatus: TaskStatus,
    options?: UndoPushOptions
  ): UndoStackEntry | null {
    const { operation, inverseOperation } = createTaskStatusChangeOperationPair(
      taskId,
      oldStatus,
      newStatus
    );
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? `Change status: ${oldStatus} → ${newStatus}`,
    });
  }

  /**
   * Record a task move between projects for undo
   *
   * Automatically generates the inverse operation and pushes to stack.
   *
   * @param taskId - The ID of the task
   * @param oldProjectId - The previous project ID
   * @param newProjectId - The new project ID
   * @param oldPosition - Optional previous position
   * @param newPosition - Optional new position
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const oldProjectId = task.projectId;
   * taskStorage.updateTask(task.id, { projectId: newProjectId });
   * undoService.recordTaskMove(task.id, oldProjectId, newProjectId);
   * ```
   */
  recordTaskMove(
    taskId: string,
    oldProjectId: string,
    newProjectId: string,
    oldPosition?: number,
    newPosition?: number,
    options?: UndoPushOptions
  ): UndoStackEntry | null {
    const { operation, inverseOperation } = createTaskMoveOperationPair(
      taskId,
      oldProjectId,
      newProjectId,
      oldPosition,
      newPosition
    );
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? 'Move task to different project',
    });
  }

  /**
   * Record a batch of operations for undo
   *
   * Use this when performing multiple related operations that should be undone together.
   *
   * @param operations - Array of operations to batch
   * @param primaryTaskId - The ID of the primary task (for reference)
   * @param options - Optional push options
   * @returns UndoStackEntry or null if push failed
   *
   * @example
   * ```typescript
   * const ops = [
   *   createTaskUpdateOperationPair(task1.id, 'title', 'Old1', 'New1').operation,
   *   createTaskUpdateOperationPair(task2.id, 'title', 'Old2', 'New2').operation,
   * ];
   * undoService.recordBatchOperation(ops, task1.id, { description: 'Bulk update' });
   * ```
   */
  recordBatchOperation(
    operations: UndoOperation[],
    primaryTaskId: string,
    options?: UndoPushOptions
  ): UndoStackEntry | null {
    const { operation, inverseOperation } = createBatchOperationPair(operations, primaryTaskId);
    return this.pushOperation(operation, inverseOperation, {
      ...options,
      description: options?.description ?? `${operations.length} operations`,
    });
  }

  /**
   * Get an entry by its database ID
   *
   * @param id - Entry ID
   * @returns UndoStackEntry or null if not found
   */
  private getEntryById(id: number): UndoStackEntry | null {
    try {
      const db = getGlobalDatabase().getConnection();

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
   * Get task storage for a project by looking up project path from projectId.
   *
   * @param projectId - The project ID
   * @returns TaskStorage or null if project not found
   */
  private getStorageForProject(projectId: string): ReturnType<typeof getProjectTaskStorage> | null {
    const project = projectStore.getProject(projectId);
    if (!project) {
      console.warn(`[UndoService] Project not found: ${projectId}`);
      return null;
    }
    return getProjectTaskStorage(project.path);
  }

  /**
   * Find task storage by searching all projects for a task.
   * This is a fallback when projectId is not available in operation data.
   *
   * @param taskId - The task ID to find
   * @returns Object with storage and projectId, or null if not found
   */
  private findStorageForTask(taskId: string): { storage: ReturnType<typeof getProjectTaskStorage>; projectId: string } | null {
    const projects = projectStore.getProjects();
    for (const project of projects) {
      const storage = getProjectTaskStorage(project.path);
      const task = storage.getTask(taskId);
      if (task) {
        return { storage, projectId: project.id };
      }
    }
    console.warn(`[UndoService] Task not found in any project: ${taskId}`);
    return null;
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
    const data = operation.data as TaskCreateData;

    try {
      // Get storage for the project (snapshot has projectId)
      const taskStorage = this.getStorageForProject(data.taskSnapshot.projectId);
      if (!taskStorage) {
        return { success: false, error: `Project not found: ${data.taskSnapshot.projectId}` };
      }

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
    const data = operation.data as TaskDeleteData;

    try {
      // Get storage for the project (snapshot has projectId)
      const taskStorage = this.getStorageForProject(data.taskSnapshot.projectId);
      if (!taskStorage) {
        return { success: false, error: `Project not found: ${data.taskSnapshot.projectId}` };
      }

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
    const data = operation.data as TaskUpdateData;

    try {
      // Find the task's project (update data doesn't include projectId)
      const storageInfo = this.findStorageForTask(operation.taskId);
      if (!storageInfo) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      const updated = storageInfo.storage.updateTask(operation.taskId, {
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
    const data = operation.data as TaskStatusChangeData;

    try {
      // Find the task's project (status change data doesn't include projectId)
      const storageInfo = this.findStorageForTask(operation.taskId);
      if (!storageInfo) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      const updated = storageInfo.storage.updateTask(operation.taskId, {
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
   * NOTE: Task move between projects with separate databases requires
   * read from old project + create in new project + delete from old project.
   * Currently this just updates the projectId field.
   */
  private executeTaskMove(operation: UndoOperation): UndoResult {
    const data = operation.data as TaskMoveData;

    try {
      // Find the task in the old project (where it currently exists)
      const storageInfo = this.findStorageForTask(operation.taskId);
      if (!storageInfo) {
        return { success: false, error: `Task not found: ${operation.taskId}` };
      }

      // For now, just update the projectId field in the same database
      // TODO: Full cross-project move would require copying task between databases
      const updated = storageInfo.storage.updateTask(operation.taskId, {
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
