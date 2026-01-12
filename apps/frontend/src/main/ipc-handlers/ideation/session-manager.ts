/**
 * Ideation session CRUD operations using SQLite storage
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { IPCResult, IdeationSession } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getIdeationStorage } from './ideation-storage';

/**
 * Get ideation session for a project
 */
export async function getIdeationSession(
  _event: IpcMainInvokeEvent,
  projectId: string
): Promise<IPCResult<IdeationSession | null>> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const session = storage.getSession(project.path, projectId);
    return { success: true, data: session };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read ideation'
    };
  }
}
