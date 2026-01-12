/**
 * Convert ideation ideas to tasks using SQLite storage
 */

import path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import type { IpcMainInvokeEvent } from 'electron';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type {
  IPCResult,
  Task,
  ImplementationPlan,
  TaskMetadata,
  TaskCategory,
  TaskImpact,
  TaskComplexity,
  TaskPriority,
  Idea
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getIdeationStorage } from './ideation-storage';
import { withSpecNumberLock } from '../../utils/spec-number-lock';
import { getProjectTaskStorage } from '../../task-storage';

/**
 * Create a slugified version of a title for use in directory names
 */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/**
 * Build task description from idea data
 */
function buildTaskDescription(idea: Idea): string {
  let description = `# ${idea.title}\n\n`;
  description += `${idea.description}\n\n`;
  description += `## Rationale\n${idea.rationale}\n\n`;

  if (idea.type === 'code_improvements') {
    const buildsUpon = idea.buildsUpon || [];
    if (Array.isArray(buildsUpon) && buildsUpon.length > 0) {
      description += `## Builds Upon\n${buildsUpon.map((b: string) => `- ${b}`).join('\n')}\n\n`;
    }
    if (idea.implementationApproach) {
      description += `## Implementation Approach\n${idea.implementationApproach}\n\n`;
    }
    const affectedFiles = idea.affectedFiles || [];
    if (Array.isArray(affectedFiles) && affectedFiles.length > 0) {
      description += `## Affected Files\n${affectedFiles.map((f: string) => `- ${f}`).join('\n')}\n\n`;
    }
    const existingPatterns = idea.existingPatterns || [];
    if (Array.isArray(existingPatterns) && existingPatterns.length > 0) {
      description += `## Patterns to Follow\n${existingPatterns.map((p: string) => `- ${p}`).join('\n')}\n\n`;
    }
  }

  return description;
}

/**
 * Build task metadata from idea
 */
function buildTaskMetadata(idea: Idea): TaskMetadata {
  const metadata: TaskMetadata = {
    sourceType: 'ideation',
    ideationType: idea.type,
    ideaId: idea.id,
    rationale: idea.rationale
  };

  // Map idea type to task category
  const ideaTypeToCategory: Record<string, TaskCategory> = {
    'code_improvements': 'feature',
    'ui_ux_improvements': 'ui_ux',
    'documentation_gaps': 'documentation',
    'security_hardening': 'security',
    'performance_optimizations': 'performance',
    'code_quality': 'refactoring'
  };
  metadata.category = ideaTypeToCategory[idea.type] || 'feature';

  // Extract type-specific metadata with proper type casting
  if (idea.type === 'code_improvements') {
    const effort = idea.estimatedEffort as TaskComplexity | undefined;
    metadata.estimatedEffort = effort;
    metadata.complexity = effort;
    metadata.affectedFiles = idea.affectedFiles;
  }

  return metadata;
}

/**
 * Create spec directory structure and files
 */
function createSpecFiles(
  specDir: string,
  idea: Idea,
  _taskDescription: string
): void {
  // Create the spec directory
  mkdirSync(specDir, { recursive: true });

  // Create initial implementation_plan.json
  const initialPlan: ImplementationPlan = {
    feature: idea.title,
    description: idea.description,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'backlog',
    planStatus: 'pending',
    phases: [],
    workflow_type: 'development',
    services_involved: [],
    final_acceptance: [],
    spec_file: 'spec.md'
  };
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    JSON.stringify(initialPlan, null, 2)
  );

  // Create initial spec.md
  const specContent = `# ${idea.title}

## Overview

${idea.description}

## Rationale

${idea.rationale}

---
*This spec was created from ideation and is pending detailed specification.*
`;
  writeFileSync(path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE), specContent);
}

/**
 * Convert an idea to a task
 */
export async function convertIdeaToTask(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult<Task>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    // Get idea from SQLite storage
    const storage = getIdeationStorage();
    const session = storage.getSession(project.path, projectId);

    if (!session) {
      return { success: false, error: 'Ideation not found' };
    }

    // Find the idea
    const idea = session.ideas.find((i) => i.id === ideaId);
    if (!idea) {
      return { success: false, error: 'Idea not found' };
    }

    // Get specs directory path
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const specsDir = path.join(project.path, specsBaseDir);

    // Ensure specs directory exists
    if (!existsSync(specsDir)) {
      mkdirSync(specsDir, { recursive: true });
    }

    // Use coordinated spec numbering with lock to prevent collisions
    return await withSpecNumberLock(project.path, async (lock) => {
      // Get next spec number from global scan (main + all worktrees)
      const nextNum = lock.getNextSpecNumber(project.autoBuildPath);
      const slugifiedTitle = slugifyTitle(idea.title);
      const specId = `${String(nextNum).padStart(3, '0')}-${slugifiedTitle}`;
      const specDir = path.join(specsDir, specId);

      // Build task description and metadata
      const taskDescription = buildTaskDescription(idea);
      const metadata = buildTaskMetadata(idea);

      // Create spec files (inside lock to ensure atomicity)
      createSpecFiles(specDir, idea, taskDescription);

      // Save metadata
      const metadataPath = path.join(specDir, 'task_metadata.json');
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      // Update idea status to converted in SQLite
      storage.updateIdeaLinkedTask(project.path, ideaId, specId);

      // Create task object
      const task: Task = {
        id: specId,
        specId: specId,
        projectId,
        title: idea.title,
        description: taskDescription,
        status: 'backlog',
        subtasks: [],
        logs: [],
        metadata,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Save task to SQLite database
      try {
        const taskStorage = getProjectTaskStorage(project.path);
        taskStorage.createTask(task);
        console.warn(`[IDEATION_CONVERT] Created task in SQLite: ${specId}`);
      } catch (dbErr) {
        console.error('[IDEATION_CONVERT] Failed to write to SQLite:', dbErr);
        throw dbErr;
      }

      // Invalidate cache
      projectStore.invalidateTasksCache(projectId);

      return { success: true, data: task };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to convert idea to task'
    };
  }
}
