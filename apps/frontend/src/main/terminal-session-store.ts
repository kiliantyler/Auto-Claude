import { existsSync } from 'fs';
import type { TerminalWorktreeConfig } from '../shared/types';
import { getGlobalDatabase } from './database';

/**
 * Persisted terminal session data
 */
export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  projectPath: string;  // Which project this terminal belongs to
  isClaudeMode: boolean;
  claudeSessionId?: string;  // Claude session ID for resume functionality
  outputBuffer: string;  // Last 100KB of output for replay
  createdAt: string;  // ISO timestamp
  lastActiveAt: string;  // ISO timestamp
  /** Associated worktree configuration (validated on restore) */
  worktreeConfig?: TerminalWorktreeConfig;
}

/**
 * Session date info for dropdown display
 */
export interface SessionDateInfo {
  date: string;  // YYYY-MM-DD format
  label: string;  // Human readable: "Today", "Yesterday", "Dec 10"
  sessionCount: number;  // Total sessions across all projects
  projectCount: number;  // Number of projects with sessions
}

const MAX_OUTPUT_BUFFER = 100000;  // 100KB per terminal
const MAX_DAYS_TO_KEEP = 10;  // Keep sessions for 10 days

/**
 * Get date string in YYYY-MM-DD format
 */
function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get human readable date label
 */
function getDateLabel(dateStr: string): string {
  const today = getDateString();
  const yesterday = getDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  if (dateStr === today) {
    return 'Today';
  } else if (dateStr === yesterday) {
    return 'Yesterday';
  } else {
    // Format as "Dec 10" or similar
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

/**
 * Database row type for terminal_sessions
 */
interface TerminalSessionRow {
  id: number;
  session_id: string;
  project_path: string;
  title: string;
  cwd: string;
  is_claude_mode: number;
  claude_session_id: string | null;
  output_buffer: string | null;
  worktree_config_json: string | null;
  session_date: string;
  created_at: string;
  last_active_at: string;
}

/**
 * Manages persistent terminal session storage using SQLite.
 * Sessions are stored in the global database (app.db).
 */
export class TerminalSessionStore {
  constructor() {
    // Clean up old sessions on startup
    this.cleanupOldSessions();
  }

  /**
   * Get the database connection
   */
  private getDb() {
    return getGlobalDatabase().getConnection();
  }

  /**
   * Remove sessions older than MAX_DAYS_TO_KEEP days
   */
  private cleanupOldSessions(): void {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - MAX_DAYS_TO_KEEP);
      const cutoffStr = getDateString(cutoffDate);

      const db = this.getDb();
      const result = db.prepare(`
        DELETE FROM terminal_sessions WHERE session_date < ?
      `).run(cutoffStr);

      if (result.changes > 0) {
        console.warn(`[TerminalSessionStore] Cleaned up ${result.changes} old sessions`);
      }
    } catch (error) {
      console.error('[TerminalSessionStore] Error cleaning up old sessions:', error);
    }
  }

  /**
   * Convert database row to TerminalSession object
   */
  private rowToSession(row: TerminalSessionRow): TerminalSession {
    let worktreeConfig: TerminalWorktreeConfig | undefined;
    if (row.worktree_config_json) {
      try {
        worktreeConfig = JSON.parse(row.worktree_config_json);
      } catch {
        // Invalid JSON - ignore
      }
    }

    return {
      id: row.session_id,
      title: row.title,
      cwd: row.cwd,
      projectPath: row.project_path,
      isClaudeMode: row.is_claude_mode === 1,
      claudeSessionId: row.claude_session_id || undefined,
      outputBuffer: row.output_buffer || '',
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      worktreeConfig: this.validateWorktreeConfig(worktreeConfig),
    };
  }

  /**
   * Validate worktree config - check if the worktree still exists
   * Returns undefined if worktree doesn't exist or is invalid
   */
  private validateWorktreeConfig(config: TerminalWorktreeConfig | undefined): TerminalWorktreeConfig | undefined {
    if (!config) return undefined;

    // Check if the worktree path still exists
    if (!existsSync(config.worktreePath)) {
      console.warn(`[TerminalSessionStore] Worktree path no longer exists: ${config.worktreePath}, clearing config`);
      return undefined;
    }

    return config;
  }

  /**
   * Save a terminal session (to today's bucket)
   */
  saveSession(session: TerminalSession): void {
    try {
      const db = this.getDb();
      const today = getDateString();
      const now = new Date().toISOString();

      const stmt = db.prepare(`
        INSERT INTO terminal_sessions
        (session_id, project_path, title, cwd, is_claude_mode, claude_session_id, output_buffer, worktree_config_json, session_date, created_at, last_active_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, session_date) DO UPDATE SET
          title = excluded.title,
          cwd = excluded.cwd,
          is_claude_mode = excluded.is_claude_mode,
          claude_session_id = excluded.claude_session_id,
          output_buffer = excluded.output_buffer,
          worktree_config_json = excluded.worktree_config_json,
          last_active_at = excluded.last_active_at
      `);

      stmt.run(
        session.id,
        session.projectPath,
        session.title,
        session.cwd,
        session.isClaudeMode ? 1 : 0,
        session.claudeSessionId || null,
        session.outputBuffer.slice(-MAX_OUTPUT_BUFFER),
        session.worktreeConfig ? JSON.stringify(session.worktreeConfig) : null,
        today,
        session.createdAt || now,
        now
      );
    } catch (error) {
      console.error('[TerminalSessionStore] Error saving session:', error);
    }
  }

  /**
   * Get most recent sessions for a project.
   * First checks today, then looks at the most recent date with sessions.
   * When restoring from a previous date, MIGRATES sessions to today.
   */
  getSessions(projectPath: string): TerminalSession[] {
    try {
      const db = this.getDb();
      const today = getDateString();

      // First check today
      const todaySessions = db.prepare(`
        SELECT * FROM terminal_sessions
        WHERE project_path = ? AND session_date = ?
        ORDER BY last_active_at DESC
      `).all(projectPath, today) as TerminalSessionRow[];

      if (todaySessions.length > 0) {
        return todaySessions.map(row => this.rowToSession(row));
      }

      // If no sessions today, find the most recent date with sessions for this project
      const mostRecentDate = db.prepare(`
        SELECT DISTINCT session_date FROM terminal_sessions
        WHERE project_path = ? AND session_date != ?
        ORDER BY session_date DESC
        LIMIT 1
      `).get(projectPath, today) as { session_date: string } | undefined;

      if (mostRecentDate) {
        console.warn(`[TerminalSessionStore] No sessions today, migrating sessions from ${mostRecentDate.session_date} to today`);

        const oldSessions = db.prepare(`
          SELECT * FROM terminal_sessions
          WHERE project_path = ? AND session_date = ?
        `).all(projectPath, mostRecentDate.session_date) as TerminalSessionRow[];

        // Migrate: update session_date to today
        const now = new Date().toISOString();
        const updateStmt = db.prepare(`
          UPDATE terminal_sessions
          SET session_date = ?, last_active_at = ?
          WHERE project_path = ? AND session_date = ?
        `);
        updateStmt.run(today, now, projectPath, mostRecentDate.session_date);

        console.warn(`[TerminalSessionStore] Migrated ${oldSessions.length} sessions from ${mostRecentDate.session_date} to ${today}`);

        return oldSessions.map(row => ({
          ...this.rowToSession(row),
          lastActiveAt: now,
        }));
      }

      return [];
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting sessions:', error);
      return [];
    }
  }

  /**
   * Get sessions for a specific date and project
   */
  getSessionsForDate(date: string, projectPath: string): TerminalSession[] {
    try {
      const db = this.getDb();
      const rows = db.prepare(`
        SELECT * FROM terminal_sessions
        WHERE project_path = ? AND session_date = ?
        ORDER BY last_active_at DESC
      `).all(projectPath, date) as TerminalSessionRow[];

      return rows.map(row => this.rowToSession(row));
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting sessions for date:', error);
      return [];
    }
  }

  /**
   * Get all sessions for a specific date (all projects)
   */
  getAllSessionsForDate(date: string): Record<string, TerminalSession[]> {
    try {
      const db = this.getDb();
      const rows = db.prepare(`
        SELECT * FROM terminal_sessions
        WHERE session_date = ?
        ORDER BY project_path, last_active_at DESC
      `).all(date) as TerminalSessionRow[];

      const result: Record<string, TerminalSession[]> = {};
      for (const row of rows) {
        if (!result[row.project_path]) {
          result[row.project_path] = [];
        }
        result[row.project_path].push(this.rowToSession(row));
      }

      return result;
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting all sessions for date:', error);
      return {};
    }
  }

  /**
   * Get available session dates with metadata
   */
  getAvailableDates(projectPath?: string): SessionDateInfo[] {
    try {
      const db = this.getDb();

      let query: string;
      let params: string[];

      if (projectPath) {
        query = `
          SELECT session_date, COUNT(*) as session_count, COUNT(DISTINCT project_path) as project_count
          FROM terminal_sessions
          WHERE project_path = ?
          GROUP BY session_date
          ORDER BY session_date DESC
        `;
        params = [projectPath];
      } else {
        query = `
          SELECT session_date, COUNT(*) as session_count, COUNT(DISTINCT project_path) as project_count
          FROM terminal_sessions
          GROUP BY session_date
          ORDER BY session_date DESC
        `;
        params = [];
      }

      const rows = db.prepare(query).all(...params) as Array<{
        session_date: string;
        session_count: number;
        project_count: number;
      }>;

      return rows.map(row => ({
        date: row.session_date,
        label: getDateLabel(row.session_date),
        sessionCount: row.session_count,
        projectCount: row.project_count,
      }));
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting available dates:', error);
      return [];
    }
  }

  /**
   * Get a specific session
   */
  getSession(projectPath: string, sessionId: string): TerminalSession | undefined {
    try {
      const db = this.getDb();
      const today = getDateString();

      const row = db.prepare(`
        SELECT * FROM terminal_sessions
        WHERE project_path = ? AND session_id = ? AND session_date = ?
      `).get(projectPath, sessionId, today) as TerminalSessionRow | undefined;

      return row ? this.rowToSession(row) : undefined;
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting session:', error);
      return undefined;
    }
  }

  /**
   * Remove a session (from today's sessions)
   */
  removeSession(projectPath: string, sessionId: string): void {
    try {
      const db = this.getDb();
      const today = getDateString();

      db.prepare(`
        DELETE FROM terminal_sessions
        WHERE project_path = ? AND session_id = ? AND session_date = ?
      `).run(projectPath, sessionId, today);
    } catch (error) {
      console.error('[TerminalSessionStore] Error removing session:', error);
    }
  }

  /**
   * Clear all sessions for a project (from today)
   */
  clearProjectSessions(projectPath: string): void {
    try {
      const db = this.getDb();
      const today = getDateString();

      db.prepare(`
        DELETE FROM terminal_sessions
        WHERE project_path = ? AND session_date = ?
      `).run(projectPath, today);
    } catch (error) {
      console.error('[TerminalSessionStore] Error clearing project sessions:', error);
    }
  }

  /**
   * Clear sessions for a specific date and project
   */
  clearSessionsForDate(date: string, projectPath?: string): void {
    try {
      const db = this.getDb();

      if (projectPath) {
        db.prepare(`
          DELETE FROM terminal_sessions
          WHERE project_path = ? AND session_date = ?
        `).run(projectPath, date);
      } else {
        db.prepare(`
          DELETE FROM terminal_sessions
          WHERE session_date = ?
        `).run(date);
      }
    } catch (error) {
      console.error('[TerminalSessionStore] Error clearing sessions for date:', error);
    }
  }

  /**
   * Update output buffer for a session
   */
  updateOutputBuffer(projectPath: string, sessionId: string, output: string): void {
    try {
      const db = this.getDb();
      const today = getDateString();
      const now = new Date().toISOString();

      // Get current buffer and append
      const row = db.prepare(`
        SELECT output_buffer FROM terminal_sessions
        WHERE project_path = ? AND session_id = ? AND session_date = ?
      `).get(projectPath, sessionId, today) as { output_buffer: string | null } | undefined;

      if (row) {
        const currentBuffer = row.output_buffer || '';
        const newBuffer = (currentBuffer + output).slice(-MAX_OUTPUT_BUFFER);

        db.prepare(`
          UPDATE terminal_sessions
          SET output_buffer = ?, last_active_at = ?
          WHERE project_path = ? AND session_id = ? AND session_date = ?
        `).run(newBuffer, now, projectPath, sessionId, today);
      }
    } catch (error) {
      // Don't log errors for frequent buffer updates to avoid spam
    }
  }

  /**
   * Update Claude session ID for a terminal
   */
  updateClaudeSessionId(projectPath: string, terminalId: string, claudeSessionId: string): void {
    try {
      const db = this.getDb();
      const today = getDateString();

      db.prepare(`
        UPDATE terminal_sessions
        SET claude_session_id = ?, is_claude_mode = 1
        WHERE project_path = ? AND session_id = ? AND session_date = ?
      `).run(claudeSessionId, projectPath, terminalId, today);

      console.warn('[TerminalSessionStore] Saved Claude session ID:', claudeSessionId, 'for terminal:', terminalId);
    } catch (error) {
      console.error('[TerminalSessionStore] Error updating Claude session ID:', error);
    }
  }

  /**
   * Save all pending changes - no-op for SQLite (commits are automatic)
   */
  saveAllPending(): void {
    // SQLite commits are automatic, nothing to do
  }

  /**
   * Get all sessions (for debugging)
   */
  getAllSessions(): { version: number; sessionsByDate: Record<string, Record<string, TerminalSession[]>> } {
    try {
      const db = this.getDb();
      const rows = db.prepare(`
        SELECT * FROM terminal_sessions
        ORDER BY session_date DESC, project_path, last_active_at DESC
      `).all() as TerminalSessionRow[];

      const sessionsByDate: Record<string, Record<string, TerminalSession[]>> = {};
      for (const row of rows) {
        if (!sessionsByDate[row.session_date]) {
          sessionsByDate[row.session_date] = {};
        }
        if (!sessionsByDate[row.session_date][row.project_path]) {
          sessionsByDate[row.session_date][row.project_path] = [];
        }
        sessionsByDate[row.session_date][row.project_path].push(this.rowToSession(row));
      }

      return { version: 2, sessionsByDate };
    } catch (error) {
      console.error('[TerminalSessionStore] Error getting all sessions:', error);
      return { version: 2, sessionsByDate: {} };
    }
  }
}

// Singleton instance
let instance: TerminalSessionStore | null = null;

export function getTerminalSessionStore(): TerminalSessionStore {
  if (!instance) {
    instance = new TerminalSessionStore();
  }
  return instance;
}
