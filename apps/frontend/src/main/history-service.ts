/**
 * History Service - Task Audit Logging Query Layer
 * =================================================
 *
 * Provides query methods for task history/audit logging stored in the task_history table.
 * History entries are automatically created by database triggers on task INSERT/UPDATE/DELETE.
 *
 * Key Features:
 * - Query history for a specific task (getTaskHistory)
 * - Get recent changes across all tasks (getRecentChanges)
 * - Group changes by session (getSessionChanges)
 * - Pagination support for large history sets
 * - Feature flag support (ENABLE_TASK_HISTORY)
 *
 * Usage:
 * ```typescript
 * const service = getHistoryService();
 *
 * // Get history for a task
 * const history = service.getTaskHistory('task-123');
 *
 * // Get recent changes
 * const recent = service.getRecentChanges(50);
 *
 * // Get changes grouped by session
 * const sessionChanges = service.getSessionChanges('session-456');
 * ```
 */

import type {
  TaskHistoryEntry,
  HistoryAction,
  ChangedBy,
  DatabaseHistoryRow,
  HistoryQueryOptions,
  HistoryQueryResult,
  SessionHistoryGroup,
  RecentActivityItem,
} from '../shared/types';
import { getDatabaseConnection } from './database';

/**
 * History Service
 * Handles task history query operations from SQLite database
 */
export class HistoryService {
  private readonly ENABLE_TASK_HISTORY: boolean;

  constructor() {
    // Enable task history by default
    // Set ENABLE_TASK_HISTORY=false to disable history features
    this.ENABLE_TASK_HISTORY = process.env.ENABLE_TASK_HISTORY !== 'false';
    console.log(`[HistoryService] Task history feature: ${this.ENABLE_TASK_HISTORY ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Check if history feature is enabled
   *
   * @returns true if history feature is enabled
   */
  isEnabled(): boolean {
    return this.ENABLE_TASK_HISTORY;
  }

  /**
   * Get the full history for a specific task
   *
   * @param taskId - Task ID to get history for
   * @param options - Optional query options (limit, offset)
   * @returns HistoryQueryResult with entries and pagination info
   */
  getTaskHistory(taskId: string, options?: { limit?: number; offset?: number }): HistoryQueryResult {
    if (!this.ENABLE_TASK_HISTORY) {
      return { entries: [], total: 0, hasMore: false };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const limit = options?.limit ?? 50;
      const offset = options?.offset ?? 0;

      // Get total count for pagination
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM task_history WHERE task_id = ?');
      const countResult = countStmt.get(taskId) as { count: number };
      const total = countResult.count;

      // Get history entries with pagination
      const stmt = db.prepare(`
        SELECT * FROM task_history
        WHERE task_id = ?
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(taskId, limit, offset) as DatabaseHistoryRow[];

      const entries = rows.map((row) => this.rowToEntry(row));

      return {
        entries,
        total,
        hasMore: offset + entries.length < total,
      };
    } catch (error) {
      console.error(`[HistoryService] Failed to get task history for ${taskId}:`, error);
      return { entries: [], total: 0, hasMore: false };
    }
  }

  /**
   * Get recent changes across all tasks
   *
   * @param limit - Maximum number of entries to return (default 50)
   * @param options - Optional filters (action type, date range)
   * @returns Array of history entries with task info
   */
  getRecentChanges(limit: number = 50, options?: HistoryQueryOptions): RecentActivityItem[] {
    if (!this.ENABLE_TASK_HISTORY) {
      return [];
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Build query with optional filters
      let query = `
        SELECT h.*, t.title as task_title, t.status as task_status
        FROM task_history h
        LEFT JOIN tasks t ON h.task_id = t.id
      `;
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (options?.action) {
        conditions.push('h.action = ?');
        params.push(options.action);
      }

      if (options?.startDate) {
        conditions.push('h.timestamp >= ?');
        params.push(options.startDate);
      }

      if (options?.endDate) {
        conditions.push('h.timestamp <= ?');
        params.push(options.endDate);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY h.timestamp DESC LIMIT ?';
      params.push(limit);

      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as (DatabaseHistoryRow & { task_title: string | null; task_status: string | null })[];

      return rows.map((row) => ({
        entry: this.rowToEntry(row),
        taskTitle: row.task_title || 'Unknown Task',
        taskStatus: row.task_status || 'unknown',
      }));
    } catch (error) {
      console.error('[HistoryService] Failed to get recent changes:', error);
      return [];
    }
  }

  /**
   * Get all changes for a specific session
   *
   * Sessions group related changes that were made together (e.g., during a single edit session).
   *
   * @param sessionId - Session ID to get changes for
   * @returns SessionHistoryGroup with all changes in the session
   */
  getSessionChanges(sessionId: string): SessionHistoryGroup | null {
    if (!this.ENABLE_TASK_HISTORY) {
      return null;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare(`
        SELECT * FROM task_history
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `);
      const rows = stmt.all(sessionId) as DatabaseHistoryRow[];

      if (rows.length === 0) {
        return null;
      }

      const entries = rows.map((row) => this.rowToEntry(row));

      return {
        sessionId,
        entries,
        startTime: entries[0].timestamp,
        endTime: entries[entries.length - 1].timestamp,
      };
    } catch (error) {
      console.error(`[HistoryService] Failed to get session changes for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Get all distinct sessions with their entry counts
   *
   * Useful for displaying a session picker in the UI.
   *
   * @param limit - Maximum number of sessions to return (default 20)
   * @returns Array of session info objects
   */
  getRecentSessions(limit: number = 20): { sessionId: string; entryCount: number; lastActivity: string }[] {
    if (!this.ENABLE_TASK_HISTORY) {
      return [];
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare(`
        SELECT
          session_id,
          COUNT(*) as entry_count,
          MAX(timestamp) as last_activity
        FROM task_history
        WHERE session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY last_activity DESC
        LIMIT ?
      `);

      const rows = stmt.all(limit) as { session_id: string; entry_count: number; last_activity: string }[];

      return rows.map((row) => ({
        sessionId: row.session_id,
        entryCount: row.entry_count,
        lastActivity: row.last_activity,
      }));
    } catch (error) {
      console.error('[HistoryService] Failed to get recent sessions:', error);
      return [];
    }
  }

  /**
   * Query history with flexible filters
   *
   * @param options - Query options with filters and pagination
   * @returns HistoryQueryResult with entries and pagination info
   */
  queryHistory(options: HistoryQueryOptions): HistoryQueryResult {
    if (!this.ENABLE_TASK_HISTORY) {
      return { entries: [], total: 0, hasMore: false };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;

      // Build WHERE clause
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options.taskId) {
        conditions.push('task_id = ?');
        params.push(options.taskId);
      }

      if (options.action) {
        conditions.push('action = ?');
        params.push(options.action);
      }

      if (options.sessionId) {
        conditions.push('session_id = ?');
        params.push(options.sessionId);
      }

      if (options.startDate) {
        conditions.push('timestamp >= ?');
        params.push(options.startDate);
      }

      if (options.endDate) {
        conditions.push('timestamp <= ?');
        params.push(options.endDate);
      }

      const whereClause = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

      // Get total count
      const countQuery = `SELECT COUNT(*) as count FROM task_history${whereClause}`;
      const countStmt = db.prepare(countQuery);
      const countResult = countStmt.get(...params) as { count: number };
      const total = countResult.count;

      // Get entries with pagination
      const query = `
        SELECT * FROM task_history${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `;
      const stmt = db.prepare(query);
      const rows = stmt.all(...params, limit, offset) as DatabaseHistoryRow[];

      const entries = rows.map((row) => this.rowToEntry(row));

      return {
        entries,
        total,
        hasMore: offset + entries.length < total,
      };
    } catch (error) {
      console.error('[HistoryService] Failed to query history:', error);
      return { entries: [], total: 0, hasMore: false };
    }
  }

  /**
   * Get the count of history entries for a task
   *
   * @param taskId - Task ID to count history for
   * @returns Number of history entries
   */
  getTaskHistoryCount(taskId: string): number {
    if (!this.ENABLE_TASK_HISTORY) {
      return 0;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const stmt = db.prepare('SELECT COUNT(*) as count FROM task_history WHERE task_id = ?');
      const result = stmt.get(taskId) as { count: number };

      return result.count;
    } catch (error) {
      console.error(`[HistoryService] Failed to get history count for ${taskId}:`, error);
      return 0;
    }
  }

  /**
   * Convert database row to TaskHistoryEntry object
   *
   * @param row - Database row from task_history table
   * @returns TaskHistoryEntry object
   */
  private rowToEntry(row: DatabaseHistoryRow): TaskHistoryEntry {
    return {
      id: row.id,
      taskId: row.task_id,
      action: row.action as HistoryAction,
      fieldName: row.field_name || undefined,
      oldValue: row.old_value || undefined,
      newValue: row.new_value || undefined,
      changedBy: (row.changed_by || 'user') as ChangedBy,
      timestamp: row.timestamp,
      sessionId: row.session_id || undefined,
    };
  }
}

// Singleton instance
let _instance: HistoryService | null = null;

/**
 * Get the singleton HistoryService instance
 *
 * @returns HistoryService instance
 */
export function getHistoryService(): HistoryService {
  if (!_instance) {
    _instance = new HistoryService();
  }
  return _instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetHistoryService(): void {
  _instance = null;
}
