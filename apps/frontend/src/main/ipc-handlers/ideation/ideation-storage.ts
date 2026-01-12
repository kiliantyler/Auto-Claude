/**
 * SQLite storage for ideation sessions and ideas
 * Replaces .auto-claude/ideation/ideation.json file storage
 */

import type { IdeationSession, Idea, IdeationType, IdeationStatus } from '../../../shared/types';
import { getProjectDatabaseManager } from '../../database';

/**
 * Database row types
 */
interface IdeationSessionRow {
  id: string;
  project_id: string;
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

interface IdeaRow {
  id: string;
  session_id: string;
  idea_type: string;
  title: string;
  description: string | null;
  rationale: string | null;
  estimated_effort: string | null;
  implementation_approach: string | null;
  status: string;
  builds_upon_json: string | null;
  affected_files_json: string | null;
  existing_patterns_json: string | null;
  created_at: string;
}

/**
 * Ideation storage service using SQLite
 */
export class IdeationStorage {
  /**
   * Get database connection for a project
   */
  private getDb(projectPath: string) {
    return getProjectDatabaseManager().getConnection(projectPath).getConnection();
  }

  /**
   * Convert database row to Idea object
   */
  private rowToIdea(row: IdeaRow): Idea {
    return {
      id: row.id,
      type: row.idea_type as IdeationType,
      title: row.title,
      description: row.description || '',
      rationale: row.rationale || '',
      estimatedEffort: (row.estimated_effort as Idea['estimatedEffort']) || undefined,
      implementationApproach: row.implementation_approach || undefined,
      status: (row.status as IdeationStatus) || 'draft',
      buildsUpon: row.builds_upon_json ? JSON.parse(row.builds_upon_json) : undefined,
      affectedFiles: row.affected_files_json ? JSON.parse(row.affected_files_json) : undefined,
      existingPatterns: row.existing_patterns_json ? JSON.parse(row.existing_patterns_json) : undefined,
      createdAt: new Date(row.created_at)
    };
  }

  /**
   * Get ideation session for a project
   */
  getSession(projectPath: string, projectId: string): IdeationSession | null {
    try {
      const db = this.getDb(projectPath);

      // Get the most recent session for this project
      const sessionRow = db.prepare(`
        SELECT * FROM ideation_sessions
        WHERE project_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(projectId) as IdeationSessionRow | undefined;

      if (!sessionRow) return null;

      // Get all ideas for this session
      const ideaRows = db.prepare(`
        SELECT * FROM ideas
        WHERE session_id = ?
        ORDER BY created_at ASC
      `).all(sessionRow.id) as IdeaRow[];

      // Parse config
      let config: IdeationSession['config'] = {
        enabledTypes: [],
        includeRoadmapContext: true,
        maxIdeasPerType: 5
      };
      if (sessionRow.config_json) {
        try {
          const parsed = JSON.parse(sessionRow.config_json);
          config = {
            enabledTypes: parsed.enabledTypes || parsed.enabled_types || [],
            includeRoadmapContext: parsed.includeRoadmapContext ?? parsed.include_roadmap_context ?? true,
            includeKanbanContext: parsed.includeKanbanContext ?? parsed.include_kanban_context ?? true,
            maxIdeasPerType: parsed.maxIdeasPerType || parsed.max_ideas_per_type || 5
          };
        } catch {
          // Use defaults
        }
      }

      return {
        id: sessionRow.id,
        projectId: sessionRow.project_id,
        config,
        ideas: ideaRows.map(row => this.rowToIdea(row)),
        generatedAt: new Date(sessionRow.created_at),
        updatedAt: new Date(sessionRow.updated_at)
      };
    } catch (error) {
      console.error('[IdeationStorage] Error getting session:', error);
      return null;
    }
  }

  /**
   * Save or update an ideation session
   */
  saveSession(projectPath: string, session: IdeationSession): void {
    try {
      const db = this.getDb(projectPath);

      const transaction = db.transaction(() => {
        // Upsert session
        const configJson = JSON.stringify({
          enabledTypes: session.config.enabledTypes,
          includeRoadmapContext: session.config.includeRoadmapContext,
          includeKanbanContext: session.config.includeKanbanContext,
          maxIdeasPerType: session.config.maxIdeasPerType
        });

        db.prepare(`
          INSERT INTO ideation_sessions (id, project_id, config_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `).run(
          session.id,
          session.projectId,
          configJson,
          session.generatedAt?.toISOString() || new Date().toISOString(),
          new Date().toISOString()
        );

        // Delete existing ideas and re-insert
        db.prepare('DELETE FROM ideas WHERE session_id = ?').run(session.id);

        const insertIdea = db.prepare(`
          INSERT INTO ideas (id, session_id, idea_type, title, description, rationale,
            estimated_effort, implementation_approach, status, builds_upon_json,
            affected_files_json, existing_patterns_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const idea of session.ideas) {
          insertIdea.run(
            idea.id,
            session.id,
            idea.type,
            idea.title,
            idea.description || null,
            idea.rationale || null,
            idea.estimatedEffort || null,
            idea.implementationApproach || null,
            idea.status || 'draft',
            idea.buildsUpon ? JSON.stringify(idea.buildsUpon) : null,
            idea.affectedFiles ? JSON.stringify(idea.affectedFiles) : null,
            idea.existingPatterns ? JSON.stringify(idea.existingPatterns) : null,
            idea.createdAt?.toISOString() || new Date().toISOString()
          );
        }
      });

      transaction();
    } catch (error) {
      console.error('[IdeationStorage] Error saving session:', error);
      throw error;
    }
  }

  /**
   * Update a single idea's status
   */
  updateIdeaStatus(projectPath: string, ideaId: string, status: IdeationStatus): boolean {
    try {
      const db = this.getDb(projectPath);

      const result = db.prepare(`
        UPDATE ideas SET status = ? WHERE id = ?
      `).run(status, ideaId);

      // Update session timestamp
      db.prepare(`
        UPDATE ideation_sessions SET updated_at = datetime('now')
        WHERE id = (SELECT session_id FROM ideas WHERE id = ?)
      `).run(ideaId);

      return result.changes > 0;
    } catch (error) {
      console.error('[IdeationStorage] Error updating idea status:', error);
      return false;
    }
  }

  /**
   * Dismiss all ideas in a session
   */
  dismissAllIdeas(projectPath: string, projectId: string): number {
    try {
      const db = this.getDb(projectPath);

      // Get the session for this project
      const session = db.prepare(`
        SELECT id FROM ideation_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1
      `).get(projectId) as { id: string } | undefined;

      if (!session) return 0;

      const result = db.prepare(`
        UPDATE ideas SET status = 'dismissed'
        WHERE session_id = ? AND status NOT IN ('dismissed', 'converted')
      `).run(session.id);

      // Update session timestamp
      db.prepare(`
        UPDATE ideation_sessions SET updated_at = datetime('now') WHERE id = ?
      `).run(session.id);

      return result.changes;
    } catch (error) {
      console.error('[IdeationStorage] Error dismissing all ideas:', error);
      return 0;
    }
  }

  /**
   * Delete a single idea
   */
  deleteIdea(projectPath: string, ideaId: string): boolean {
    try {
      const db = this.getDb(projectPath);

      // Get session ID before deleting
      const idea = db.prepare('SELECT session_id FROM ideas WHERE id = ?').get(ideaId) as { session_id: string } | undefined;

      const result = db.prepare('DELETE FROM ideas WHERE id = ?').run(ideaId);

      // Update session timestamp
      if (idea) {
        db.prepare(`
          UPDATE ideation_sessions SET updated_at = datetime('now') WHERE id = ?
        `).run(idea.session_id);
      }

      return result.changes > 0;
    } catch (error) {
      console.error('[IdeationStorage] Error deleting idea:', error);
      return false;
    }
  }

  /**
   * Delete multiple ideas
   */
  deleteMultipleIdeas(projectPath: string, ideaIds: string[]): number {
    try {
      const db = this.getDb(projectPath);

      const transaction = db.transaction(() => {
        // Get session IDs before deleting
        const sessionIds = new Set<string>();
        for (const id of ideaIds) {
          const idea = db.prepare('SELECT session_id FROM ideas WHERE id = ?').get(id) as { session_id: string } | undefined;
          if (idea) sessionIds.add(idea.session_id);
        }

        // Delete ideas
        const placeholders = ideaIds.map(() => '?').join(',');
        const result = db.prepare(`DELETE FROM ideas WHERE id IN (${placeholders})`).run(...ideaIds);

        // Update session timestamps
        for (const sessionId of sessionIds) {
          db.prepare(`
            UPDATE ideation_sessions SET updated_at = datetime('now') WHERE id = ?
          `).run(sessionId);
        }

        return result.changes;
      });

      return transaction();
    } catch (error) {
      console.error('[IdeationStorage] Error deleting multiple ideas:', error);
      return 0;
    }
  }

  /**
   * Update idea's linked task ID
   */
  updateIdeaLinkedTask(projectPath: string, ideaId: string, taskId: string): boolean {
    try {
      const db = this.getDb(projectPath);

      // The ideas table doesn't have linked_task_id column, so we store it in a different way
      // For now, update status to 'converted' which indicates it was converted to a task
      const result = db.prepare(`
        UPDATE ideas SET status = 'converted' WHERE id = ?
      `).run(ideaId);

      // Update session timestamp
      db.prepare(`
        UPDATE ideation_sessions SET updated_at = datetime('now')
        WHERE id = (SELECT session_id FROM ideas WHERE id = ?)
      `).run(ideaId);

      return result.changes > 0;
    } catch (error) {
      console.error('[IdeationStorage] Error updating idea linked task:', error);
      return false;
    }
  }
}

// Singleton instance
let _instance: IdeationStorage | null = null;

export function getIdeationStorage(): IdeationStorage {
  if (!_instance) {
    _instance = new IdeationStorage();
  }
  return _instance;
}
