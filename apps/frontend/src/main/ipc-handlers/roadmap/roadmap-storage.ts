/**
 * SQLite storage for roadmaps
 * Replaces .auto-claude/roadmap/roadmap.json file storage
 */

import type { Roadmap, RoadmapPhase, RoadmapFeature, RoadmapFeatureStatus, CompetitorAnalysis } from '../../../shared/types';
import { getProjectDatabaseManager } from '../../database';

/**
 * Database row types
 */
interface RoadmapRow {
  id: string;
  project_id: string;
  project_name: string;
  version: string | null;
  vision: string | null;
  target_audience_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface RoadmapPhaseRow {
  id: string;
  roadmap_id: string;
  name: string;
  description: string | null;
  phase_order: number;
  status: string;
}

interface RoadmapMilestoneRow {
  id: string;
  phase_id: string;
  title: string;
  description: string | null;
  status: string;
  features_json: string | null;
}

interface RoadmapFeatureRow {
  id: string;
  roadmap_id: string;
  phase_id: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  priority: string | null;
  complexity: string | null;
  impact: string | null;
  status: string;
  dependencies_json: string | null;
  acceptance_criteria_json: string | null;
  user_stories_json: string | null;
  linked_spec_id: string | null;
  competitor_insight_ids_json: string | null;
}

/**
 * Roadmap storage service using SQLite
 */
export class RoadmapStorage {
  /**
   * Get database connection for a project
   */
  private getDb(projectPath: string) {
    return getProjectDatabaseManager().getConnection(projectPath).getConnection();
  }

  /**
   * Get roadmap for a project
   */
  getRoadmap(projectPath: string, projectId: string): Roadmap | null {
    try {
      const db = this.getDb(projectPath);

      // Get the most recent roadmap for this project
      const roadmapRow = db.prepare(`
        SELECT * FROM roadmaps
        WHERE project_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(projectId) as RoadmapRow | undefined;

      if (!roadmapRow) return null;

      // Get phases
      const phaseRows = db.prepare(`
        SELECT * FROM roadmap_phases
        WHERE roadmap_id = ?
        ORDER BY phase_order ASC
      `).all(roadmapRow.id) as RoadmapPhaseRow[];

      // Get milestones for each phase
      const phases: RoadmapPhase[] = phaseRows.map(phase => {
        const milestoneRows = db.prepare(`
          SELECT * FROM roadmap_milestones WHERE phase_id = ?
        `).all(phase.id) as RoadmapMilestoneRow[];

        return {
          id: phase.id,
          name: phase.name,
          description: phase.description || undefined,
          order: phase.phase_order,
          status: phase.status as RoadmapPhase['status'],
          features: [], // Will be populated from feature associations
          milestones: milestoneRows.map(m => ({
            id: m.id,
            title: m.title,
            description: m.description || undefined,
            features: m.features_json ? JSON.parse(m.features_json) : [],
            status: m.status as 'planned' | 'in_progress' | 'completed'
          }))
        };
      });

      // Get features
      const featureRows = db.prepare(`
        SELECT * FROM roadmap_features WHERE roadmap_id = ?
      `).all(roadmapRow.id) as RoadmapFeatureRow[];

      const features: RoadmapFeature[] = featureRows.map(f => ({
        id: f.id,
        title: f.title,
        description: f.description || undefined,
        rationale: f.rationale || '',
        priority: (f.priority as RoadmapFeature['priority']) || 'should',
        complexity: (f.complexity as RoadmapFeature['complexity']) || 'medium',
        impact: (f.impact as RoadmapFeature['impact']) || 'medium',
        phaseId: f.phase_id || undefined,
        dependencies: f.dependencies_json ? JSON.parse(f.dependencies_json) : [],
        status: (f.status as RoadmapFeatureStatus) || 'under_review',
        acceptanceCriteria: f.acceptance_criteria_json ? JSON.parse(f.acceptance_criteria_json) : [],
        userStories: f.user_stories_json ? JSON.parse(f.user_stories_json) : [],
        linkedSpecId: f.linked_spec_id || undefined,
        competitorInsightIds: f.competitor_insight_ids_json ? JSON.parse(f.competitor_insight_ids_json) : undefined
      }));

      // Populate phase features
      for (const phase of phases) {
        phase.features = features
          .filter(f => f.phaseId === phase.id)
          .map(f => f.id);
      }

      // Parse target audience
      let targetAudience = { primary: '', secondary: [] as string[] };
      if (roadmapRow.target_audience_json) {
        try {
          targetAudience = JSON.parse(roadmapRow.target_audience_json);
        } catch {
          // Use defaults
        }
      }

      return {
        id: roadmapRow.id,
        projectId: roadmapRow.project_id,
        projectName: roadmapRow.project_name,
        version: roadmapRow.version || '1.0',
        vision: roadmapRow.vision || '',
        targetAudience,
        phases,
        features,
        status: 'active',
        createdAt: new Date(roadmapRow.created_at),
        updatedAt: new Date(roadmapRow.updated_at)
      };
    } catch (error) {
      console.error('[RoadmapStorage] Error getting roadmap:', error);
      return null;
    }
  }

  /**
   * Save or update a roadmap
   */
  saveRoadmap(projectPath: string, roadmap: Roadmap): void {
    try {
      const db = this.getDb(projectPath);

      const transaction = db.transaction(() => {
        // Upsert roadmap
        db.prepare(`
          INSERT INTO roadmaps (id, project_id, project_name, version, vision, target_audience_json, metadata_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            project_name = excluded.project_name,
            version = excluded.version,
            vision = excluded.vision,
            target_audience_json = excluded.target_audience_json,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `).run(
          roadmap.id,
          roadmap.projectId,
          roadmap.projectName,
          roadmap.version || '1.0',
          roadmap.vision || null,
          JSON.stringify(roadmap.targetAudience),
          JSON.stringify({ status: roadmap.status }),
          roadmap.createdAt?.toISOString() || new Date().toISOString(),
          new Date().toISOString()
        );

        // Delete existing phases, milestones, and features
        db.prepare('DELETE FROM roadmap_features WHERE roadmap_id = ?').run(roadmap.id);
        db.prepare(`
          DELETE FROM roadmap_milestones WHERE phase_id IN (
            SELECT id FROM roadmap_phases WHERE roadmap_id = ?
          )
        `).run(roadmap.id);
        db.prepare('DELETE FROM roadmap_phases WHERE roadmap_id = ?').run(roadmap.id);

        // Insert phases
        const insertPhase = db.prepare(`
          INSERT INTO roadmap_phases (id, roadmap_id, name, description, phase_order, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertMilestone = db.prepare(`
          INSERT INTO roadmap_milestones (id, phase_id, title, description, status, features_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const phase of roadmap.phases) {
          insertPhase.run(
            phase.id,
            roadmap.id,
            phase.name,
            phase.description || null,
            phase.order,
            phase.status || 'planned'
          );

          for (const milestone of phase.milestones || []) {
            insertMilestone.run(
              milestone.id,
              phase.id,
              milestone.title,
              milestone.description || null,
              milestone.status || 'planned',
              milestone.features ? JSON.stringify(milestone.features) : null
            );
          }
        }

        // Insert features
        const insertFeature = db.prepare(`
          INSERT INTO roadmap_features (id, roadmap_id, phase_id, title, description, rationale,
            priority, complexity, impact, status, dependencies_json, acceptance_criteria_json,
            user_stories_json, linked_spec_id, competitor_insight_ids_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const feature of roadmap.features) {
          insertFeature.run(
            feature.id,
            roadmap.id,
            feature.phaseId || null,
            feature.title,
            feature.description || null,
            feature.rationale || null,
            feature.priority || 'should',
            feature.complexity || 'medium',
            feature.impact || 'medium',
            feature.status || 'under_review',
            feature.dependencies ? JSON.stringify(feature.dependencies) : null,
            feature.acceptanceCriteria ? JSON.stringify(feature.acceptanceCriteria) : null,
            feature.userStories ? JSON.stringify(feature.userStories) : null,
            feature.linkedSpecId || null,
            feature.competitorInsightIds ? JSON.stringify(feature.competitorInsightIds) : null
          );
        }
      });

      transaction();
    } catch (error) {
      console.error('[RoadmapStorage] Error saving roadmap:', error);
      throw error;
    }
  }

  /**
   * Update a feature's status
   */
  updateFeatureStatus(projectPath: string, featureId: string, status: RoadmapFeatureStatus): boolean {
    try {
      const db = this.getDb(projectPath);

      const result = db.prepare(`
        UPDATE roadmap_features SET status = ? WHERE id = ?
      `).run(status, featureId);

      // Update roadmap timestamp
      db.prepare(`
        UPDATE roadmaps SET updated_at = datetime('now')
        WHERE id = (SELECT roadmap_id FROM roadmap_features WHERE id = ?)
      `).run(featureId);

      return result.changes > 0;
    } catch (error) {
      console.error('[RoadmapStorage] Error updating feature status:', error);
      return false;
    }
  }

  /**
   * Update a feature's linked spec ID
   */
  updateFeatureLinkedSpec(projectPath: string, featureId: string, specId: string): boolean {
    try {
      const db = this.getDb(projectPath);

      const result = db.prepare(`
        UPDATE roadmap_features SET linked_spec_id = ?, status = 'planned' WHERE id = ?
      `).run(specId, featureId);

      // Update roadmap timestamp
      db.prepare(`
        UPDATE roadmaps SET updated_at = datetime('now')
        WHERE id = (SELECT roadmap_id FROM roadmap_features WHERE id = ?)
      `).run(featureId);

      return result.changes > 0;
    } catch (error) {
      console.error('[RoadmapStorage] Error updating feature linked spec:', error);
      return false;
    }
  }

  /**
   * Get a specific feature by ID
   */
  getFeature(projectPath: string, featureId: string): RoadmapFeature | null {
    try {
      const db = this.getDb(projectPath);

      const row = db.prepare(`
        SELECT * FROM roadmap_features WHERE id = ?
      `).get(featureId) as RoadmapFeatureRow | undefined;

      if (!row) return null;

      return {
        id: row.id,
        title: row.title,
        description: row.description || undefined,
        rationale: row.rationale || '',
        priority: (row.priority as RoadmapFeature['priority']) || 'should',
        complexity: (row.complexity as RoadmapFeature['complexity']) || 'medium',
        impact: (row.impact as RoadmapFeature['impact']) || 'medium',
        phaseId: row.phase_id || undefined,
        dependencies: row.dependencies_json ? JSON.parse(row.dependencies_json) : [],
        status: (row.status as RoadmapFeatureStatus) || 'under_review',
        acceptanceCriteria: row.acceptance_criteria_json ? JSON.parse(row.acceptance_criteria_json) : [],
        userStories: row.user_stories_json ? JSON.parse(row.user_stories_json) : [],
        linkedSpecId: row.linked_spec_id || undefined,
        competitorInsightIds: row.competitor_insight_ids_json ? JSON.parse(row.competitor_insight_ids_json) : undefined
      };
    } catch (error) {
      console.error('[RoadmapStorage] Error getting feature:', error);
      return null;
    }
  }

  /**
   * Delete a roadmap
   */
  deleteRoadmap(projectPath: string, roadmapId: string): boolean {
    try {
      const db = this.getDb(projectPath);

      // CASCADE will delete phases, milestones, and features
      const result = db.prepare('DELETE FROM roadmaps WHERE id = ?').run(roadmapId);
      return result.changes > 0;
    } catch (error) {
      console.error('[RoadmapStorage] Error deleting roadmap:', error);
      return false;
    }
  }
}

// Singleton instance
let _instance: RoadmapStorage | null = null;

export function getRoadmapStorage(): RoadmapStorage {
  if (!_instance) {
    _instance = new RoadmapStorage();
  }
  return _instance;
}
