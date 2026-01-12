/**
 * Undo/Redo operation types for task management
 */

import type { TaskStatus } from './task';

// Operation types that can be undone/redone
// - 'task_create': A task was created
// - 'task_update': A task field was updated
// - 'task_delete': A task was deleted
// - 'task_status_change': A task's status was changed
// - 'task_move': A task was moved between projects
// - 'batch': Multiple operations grouped together
export type UndoOperationType =
  | 'task_create'
  | 'task_update'
  | 'task_delete'
  | 'task_status_change'
  | 'task_move'
  | 'batch';

/**
 * Represents a single undoable/redoable operation
 * Stored as JSON in the undo_stack table's operation/inverse_operation columns
 */
export interface UndoOperation {
  type: UndoOperationType;           // Type of operation
  taskId: string;                    // ID of the affected task
  // Data needed to perform the operation (varies by type)
  data: UndoOperationData;
}

/**
 * Union type for operation-specific data
 */
export type UndoOperationData =
  | TaskCreateData
  | TaskUpdateData
  | TaskDeleteData
  | TaskStatusChangeData
  | TaskMoveData
  | BatchOperationData;

/**
 * Data for task creation operation
 * Used to recreate a task on redo or delete it on undo
 */
export interface TaskCreateData {
  taskSnapshot: TaskSnapshot;        // Full task data at time of creation
}

/**
 * Data for task update operation
 * Stores both old and new values for reversibility
 */
export interface TaskUpdateData {
  fieldName: string;                 // Name of the field that was updated
  oldValue: unknown;                 // Previous value (for undo)
  newValue: unknown;                 // New value (for redo)
}

/**
 * Data for task deletion operation
 * Stores full task snapshot for restoration on undo
 */
export interface TaskDeleteData {
  taskSnapshot: TaskSnapshot;        // Full task data before deletion
}

/**
 * Data for task status change operation
 * Stores both old and new status values
 */
export interface TaskStatusChangeData {
  oldStatus: TaskStatus;             // Previous status (for undo)
  newStatus: TaskStatus;             // New status (for redo)
}

/**
 * Data for task move operation
 * Stores both old and new project IDs
 */
export interface TaskMoveData {
  oldProjectId: string;              // Previous project ID (for undo)
  newProjectId: string;              // New project ID (for redo)
  oldPosition?: number;              // Previous position in column (optional)
  newPosition?: number;              // New position in column (optional)
}

/**
 * Data for batch operation
 * Contains multiple operations that were performed together
 */
export interface BatchOperationData {
  operations: UndoOperation[];       // Array of operations in the batch
}

/**
 * Snapshot of task data for restoration
 * Contains all fields needed to recreate a task
 */
export interface TaskSnapshot {
  id: string;
  specId: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  metadataJson?: string;             // Serialized task metadata
  createdAt: string;                 // ISO timestamp
  updatedAt: string;                 // ISO timestamp
}

/**
 * Represents an entry in the undo stack
 * Maps to the undo_stack database table
 */
export interface UndoStackEntry {
  id: number;                        // Auto-incremented primary key
  sessionId: string;                 // Session ID for grouping operations
  sequence: number;                  // Order within the session (for stack ordering)
  operation: UndoOperation;          // The operation that was performed
  inverseOperation: UndoOperation;   // The inverse operation (for undoing)
  timestamp: string;                 // ISO timestamp when operation was recorded
  description: string;               // Human-readable description of the operation
}

/**
 * Database row type for undo_stack table
 * Used internally for mapping database results to UndoStackEntry
 */
export interface DatabaseUndoRow {
  id: number;
  session_id: string;
  sequence: number;
  operation: string;                 // JSON-serialized UndoOperation
  inverse_operation: string;         // JSON-serialized UndoOperation
  timestamp: string;
  description: string | null;
}

/**
 * Result of an undo or redo operation
 */
export interface UndoResult {
  success: boolean;                  // Whether the operation succeeded
  entry?: UndoStackEntry;            // The entry that was undone/redone
  error?: string;                    // Error message if operation failed
  affectedTaskId?: string;           // ID of the task that was affected
}

/**
 * Options for pushing an operation to the undo stack
 */
export interface UndoPushOptions {
  sessionId?: string;                // Session ID (auto-generated if not provided)
  description?: string;              // Custom description (auto-generated if not provided)
  skipInverseGeneration?: boolean;   // If true, inverse_operation must be provided
}

/**
 * Current state of the undo/redo stack
 * Used for UI display and keyboard shortcut availability
 */
export interface UndoStackState {
  undoStack: UndoStackEntry[];       // Operations that can be undone (most recent first)
  redoStack: UndoStackEntry[];       // Operations that can be redone (most recent first)
  canUndo: boolean;                  // Whether undo is available
  canRedo: boolean;                  // Whether redo is available
  isProcessing: boolean;             // Whether an undo/redo is in progress
  lastUndoDescription?: string;      // Description of the last undoable operation
  lastRedoDescription?: string;      // Description of the last redoable operation
}

/**
 * Options for clearing the undo stack
 */
export interface UndoClearOptions {
  sessionId?: string;                // Clear only entries for this session
  olderThan?: string;                // Clear entries older than this ISO timestamp
  all?: boolean;                     // Clear all entries (ignores other options)
}

/**
 * Configuration for the undo service
 */
export interface UndoConfig {
  maxStackSize: number;              // Maximum number of operations to keep (default: 50)
  sessionTimeoutMs: number;          // Session timeout in milliseconds (default: 24 hours)
  enabled: boolean;                  // Whether undo/redo is enabled
}

/**
 * Default undo configuration values
 */
export const DEFAULT_UNDO_CONFIG: UndoConfig = {
  maxStackSize: 50,
  sessionTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
  enabled: true,
};

/**
 * Helper function to generate a human-readable description for an operation
 */
export function generateOperationDescription(operation: UndoOperation): string {
  switch (operation.type) {
    case 'task_create':
      return 'Create task';
    case 'task_delete':
      return 'Delete task';
    case 'task_update': {
      const data = operation.data as TaskUpdateData;
      return `Update ${data.fieldName}`;
    }
    case 'task_status_change': {
      const data = operation.data as TaskStatusChangeData;
      return `Change status from ${data.oldStatus} to ${data.newStatus}`;
    }
    case 'task_move': {
      return 'Move task';
    }
    case 'batch': {
      const data = operation.data as BatchOperationData;
      return `${data.operations.length} operations`;
    }
    default:
      return 'Unknown operation';
  }
}
