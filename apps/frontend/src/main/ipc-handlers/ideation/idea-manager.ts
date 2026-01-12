/**
 * Individual idea operations (update, dismiss, etc.) using SQLite storage
 */

import type { IpcMainInvokeEvent } from 'electron';
import type { IPCResult, IdeationStatus } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getIdeationStorage } from './ideation-storage';

/**
 * Update an idea's status
 */
export async function updateIdeaStatus(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string,
  status: IdeationStatus
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const success = storage.updateIdeaStatus(project.path, ideaId, status);

    if (!success) {
      return { success: false, error: 'Idea not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update idea'
    };
  }
}

/**
 * Dismiss a single idea
 */
export async function dismissIdea(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const success = storage.updateIdeaStatus(project.path, ideaId, 'dismissed');

    if (!success) {
      return { success: false, error: 'Idea not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to dismiss idea'
    };
  }
}

/**
 * Dismiss all ideas in a session
 */
export async function dismissAllIdeas(
  _event: IpcMainInvokeEvent,
  projectId: string
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const dismissedCount = storage.dismissAllIdeas(project.path, projectId);

    return { success: true, data: { dismissedCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to dismiss all ideas'
    };
  }
}

/**
 * Archive a single idea (typically when converted to task)
 */
export async function archiveIdea(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const success = storage.updateIdeaStatus(project.path, ideaId, 'archived');

    if (!success) {
      return { success: false, error: 'Idea not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to archive idea'
    };
  }
}

/**
 * Delete a single idea permanently
 */
export async function deleteIdea(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaId: string
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const success = storage.deleteIdea(project.path, ideaId);

    if (!success) {
      return { success: false, error: 'Idea not found' };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete idea'
    };
  }
}

/**
 * Delete multiple ideas permanently
 */
export async function deleteMultipleIdeas(
  _event: IpcMainInvokeEvent,
  projectId: string,
  ideaIds: string[]
): Promise<IPCResult> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  try {
    const storage = getIdeationStorage();
    const deletedCount = storage.deleteMultipleIdeas(project.path, ideaIds);

    return { success: true, data: { deletedCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete ideas'
    };
  }
}
