/**
 * Task history and audit logging types
 */

// Action types for task history entries
// - 'created': Task was created
// - 'updated': Task field was modified
// - 'deleted': Task was deleted
// - 'status_changed': Task status was changed (e.g., backlog -> in_progress)
// - 'moved': Task was moved between columns/projects
export type HistoryAction = 'created' | 'updated' | 'deleted' | 'status_changed' | 'moved';

// Entity that changed the task
export type ChangedBy = 'user' | 'system' | 'agent';

/**
 * Represents a single history entry for task audit logging
 * Maps to the task_history database table
 */
export interface TaskHistoryEntry {
  id: number;                      // Auto-incremented primary key
  taskId: string;                  // Reference to the task
  action: HistoryAction;           // Type of action performed
  fieldName?: string;              // Name of the field that changed (for updates)
  oldValue?: string;               // JSON-serialized previous value
  newValue?: string;               // JSON-serialized new value
  changedBy: ChangedBy;            // Who made the change
  timestamp: string;               // ISO timestamp of the change
  sessionId?: string;              // Session ID for grouping related changes
}

/**
 * Database row type for task_history table
 * Used internally for mapping database results to TaskHistoryEntry
 */
export interface DatabaseHistoryRow {
  id: number;
  task_id: string;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  timestamp: string;
  session_id: string | null;
}

/**
 * Parsed values from history entry JSON fields
 * Used for displaying diffs in the UI
 */
export interface HistoryValueSnapshot {
  title?: string;
  description?: string;
  status?: string;
  // Additional fields can be added as needed
  [key: string]: string | undefined;
}

/**
 * Options for querying task history
 */
export interface HistoryQueryOptions {
  taskId?: string;                 // Filter by task ID
  action?: HistoryAction;          // Filter by action type
  sessionId?: string;              // Filter by session
  startDate?: string;              // Filter by date range start (ISO string)
  endDate?: string;                // Filter by date range end (ISO string)
  limit?: number;                  // Maximum number of entries to return
  offset?: number;                 // Offset for pagination
}

/**
 * Result of a history query with pagination info
 */
export interface HistoryQueryResult {
  entries: TaskHistoryEntry[];     // History entries
  total: number;                   // Total count for pagination
  hasMore: boolean;                // Whether more entries exist
}

/**
 * Grouped history entries by session
 * Used for displaying session-based history view
 */
export interface SessionHistoryGroup {
  sessionId: string;               // Session identifier
  entries: TaskHistoryEntry[];     // Entries in this session
  startTime: string;               // First entry timestamp
  endTime: string;                 // Last entry timestamp
}

/**
 * Recent activity item for dashboard/activity feed
 */
export interface RecentActivityItem {
  entry: TaskHistoryEntry;         // The history entry
  taskTitle: string;               // Task title for display
  taskStatus: string;              // Current task status
}
