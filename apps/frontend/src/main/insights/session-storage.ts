import type { InsightsSession, InsightsSessionSummary, InsightsChatMessage, InsightsModelConfig, InsightsToolUsage } from '../../shared/types';
import { getProjectDatabaseManager } from '../database';

/**
 * Database row type for insight_sessions table
 */
interface InsightSessionRow {
  id: string;
  project_id: string;
  title: string | null;
  model_config_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Database row type for session_messages table
 */
interface SessionMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  tools_used_json: string | null;
  suggested_task_json: string | null;
}

/**
 * Database row type for current_insight_session table
 */
interface CurrentSessionRow {
  project_id: string;
  session_id: string;
  updated_at: string;
}

/**
 * Session storage manager using SQLite
 * Handles persisting and loading sessions from the project-local database
 */
export class SessionStorage {
  /**
   * Get database connection for a project
   */
  private getDb(projectPath: string) {
    return getProjectDatabaseManager().getConnection(projectPath).getConnection();
  }

  /**
   * Generate a title from the first user message
   */
  generateTitle(message: string): string {
    // Truncate to first 50 characters and clean up
    const title = message.trim().replace(/\n/g, ' ').slice(0, 50);
    return title.length < message.trim().length ? `${title}...` : title;
  }

  /**
   * Convert database row to InsightsChatMessage
   */
  private rowToMessage(row: SessionMessageRow): InsightsChatMessage {
    let toolsUsed: InsightsToolUsage[] | undefined;
    if (row.tools_used_json) {
      try {
        const parsed = JSON.parse(row.tools_used_json);
        toolsUsed = parsed.map((t: { name: string; input?: string; timestamp: string }) => ({
          name: t.name,
          input: t.input,
          timestamp: new Date(t.timestamp)
        }));
      } catch {
        // Invalid JSON - ignore
      }
    }

    let suggestedTask: InsightsChatMessage['suggestedTask'] | undefined;
    if (row.suggested_task_json) {
      try {
        suggestedTask = JSON.parse(row.suggested_task_json);
      } catch {
        // Invalid JSON - ignore
      }
    }

    return {
      id: row.id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      timestamp: new Date(row.timestamp),
      toolsUsed,
      suggestedTask
    };
  }

  /**
   * Convert database row to InsightsSession (without messages)
   */
  private rowToSession(row: InsightSessionRow, messages: InsightsChatMessage[]): InsightsSession {
    let modelConfig: InsightsModelConfig | undefined;
    if (row.model_config_json) {
      try {
        modelConfig = JSON.parse(row.model_config_json);
      } catch {
        // Invalid JSON - ignore
      }
    }

    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title || undefined,
      messages,
      modelConfig,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  /**
   * Load a specific session from database
   */
  loadSessionById(projectPath: string, sessionId: string): InsightsSession | null {
    try {
      const db = this.getDb(projectPath);

      // Get session
      const sessionRow = db.prepare(`
        SELECT * FROM insight_sessions WHERE id = ?
      `).get(sessionId) as InsightSessionRow | undefined;

      if (!sessionRow) return null;

      // Get messages for this session
      const messageRows = db.prepare(`
        SELECT * FROM session_messages
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as SessionMessageRow[];

      const messages = messageRows.map(row => this.rowToMessage(row));
      return this.rowToSession(sessionRow, messages);
    } catch (error) {
      console.error('[SessionStorage] Error loading session:', error);
      return null;
    }
  }

  /**
   * Save session to database
   */
  saveSession(projectPath: string, session: InsightsSession): void {
    try {
      const db = this.getDb(projectPath);

      // Use a transaction for atomicity
      const transaction = db.transaction(() => {
        // Upsert session
        db.prepare(`
          INSERT INTO insight_sessions (id, project_id, title, model_config_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            model_config_json = excluded.model_config_json,
            updated_at = excluded.updated_at
        `).run(
          session.id,
          session.projectId,
          session.title || null,
          session.modelConfig ? JSON.stringify(session.modelConfig) : null,
          session.createdAt.toISOString(),
          session.updatedAt.toISOString()
        );

        // Delete existing messages and re-insert all
        // This ensures message order and handles message updates
        db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(session.id);

        const insertMsg = db.prepare(`
          INSERT INTO session_messages (id, session_id, role, content, timestamp, tools_used_json, suggested_task_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const msg of session.messages) {
          const toolsUsedJson = msg.toolsUsed
            ? JSON.stringify(msg.toolsUsed.map(t => ({
                name: t.name,
                input: t.input,
                timestamp: t.timestamp.toISOString()
              })))
            : null;

          insertMsg.run(
            msg.id,
            session.id,
            msg.role,
            msg.content,
            msg.timestamp.toISOString(),
            toolsUsedJson,
            msg.suggestedTask ? JSON.stringify(msg.suggestedTask) : null
          );
        }
      });

      transaction();
    } catch (error) {
      console.error('[SessionStorage] Error saving session:', error);
    }
  }

  /**
   * Delete a session from database
   */
  deleteSession(projectPath: string, sessionId: string): boolean {
    try {
      const db = this.getDb(projectPath);

      // Messages are deleted automatically via CASCADE
      const result = db.prepare('DELETE FROM insight_sessions WHERE id = ?').run(sessionId);
      return result.changes > 0;
    } catch (error) {
      console.error('[SessionStorage] Error deleting session:', error);
      return false;
    }
  }

  /**
   * List all sessions for a project
   */
  listSessions(projectPath: string): InsightsSessionSummary[] {
    try {
      const db = this.getDb(projectPath);

      // Get sessions with message count
      const rows = db.prepare(`
        SELECT
          s.id,
          s.project_id,
          s.title,
          s.created_at,
          s.updated_at,
          COUNT(m.id) as message_count
        FROM insight_sessions s
        LEFT JOIN session_messages m ON s.id = m.session_id
        WHERE s.project_id IS NOT NULL
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).all() as Array<InsightSessionRow & { message_count: number }>;

      return rows.map(row => {
        // Generate title if not present
        let title = row.title;
        if (!title && row.message_count > 0) {
          // Try to get first user message for title generation
          const firstUserMsg = db.prepare(`
            SELECT content FROM session_messages
            WHERE session_id = ? AND role = 'user'
            ORDER BY timestamp ASC LIMIT 1
          `).get(row.id) as { content: string } | undefined;

          title = firstUserMsg
            ? this.generateTitle(firstUserMsg.content)
            : 'Untitled Conversation';
        }

        return {
          id: row.id,
          projectId: row.project_id,
          title: title || 'New Conversation',
          messageCount: row.message_count,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at)
        };
      });
    } catch (error) {
      console.error('[SessionStorage] Error listing sessions:', error);
      return [];
    }
  }

  /**
   * Get current session ID for a project
   */
  getCurrentSessionId(projectPath: string): string | null {
    try {
      const db = this.getDb(projectPath);

      const row = db.prepare(`
        SELECT session_id FROM current_insight_session WHERE project_id = ?
      `).get(this.getProjectId(projectPath)) as { session_id: string } | undefined;

      return row?.session_id || null;
    } catch (error) {
      console.error('[SessionStorage] Error getting current session ID:', error);
      return null;
    }
  }

  /**
   * Save current session ID pointer
   */
  saveCurrentSessionId(projectPath: string, sessionId: string): void {
    try {
      const db = this.getDb(projectPath);
      const projectId = this.getProjectId(projectPath);

      db.prepare(`
        INSERT INTO current_insight_session (project_id, session_id, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(project_id) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `).run(projectId, sessionId);
    } catch (error) {
      console.error('[SessionStorage] Error saving current session ID:', error);
    }
  }

  /**
   * Clear current session pointer
   */
  clearCurrentSessionId(projectPath: string): void {
    try {
      const db = this.getDb(projectPath);
      const projectId = this.getProjectId(projectPath);

      db.prepare('DELETE FROM current_insight_session WHERE project_id = ?').run(projectId);
    } catch (error) {
      console.error('[SessionStorage] Error clearing current session ID:', error);
    }
  }

  /**
   * Get project ID from path (used for current_insight_session table)
   * We use the normalized path as a pseudo project ID since we don't have access to the real project ID here
   */
  private getProjectId(projectPath: string): string {
    // Use the normalized path as the identifier
    // This is consistent within the same database
    return projectPath;
  }

  /**
   * Migrate old session format to new multi-session format
   * This is a no-op for SQLite - migration happens at schema level
   */
  migrateOldSession(_projectPath: string): void {
    // No-op for SQLite storage
    // Old JSON files will be ignored, users can manually delete them
  }
}
