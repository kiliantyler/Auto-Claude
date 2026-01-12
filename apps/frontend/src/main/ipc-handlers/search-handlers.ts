/**
 * Search IPC Handlers
 * ===================
 *
 * IPC handlers for full-text search operations using FTS5.
 * These handlers expose the SearchService to the renderer process.
 *
 * Available handlers:
 * - search:query - Perform full-text search on tasks
 * - search:suggestions - Get autocomplete suggestions
 * - search:is-enabled - Check if search feature is enabled
 * - search:get-recent - Get recent search history
 * - search:clear-recent - Clear recent search history
 * - search:rebuild-index - Rebuild FTS5 index (maintenance)
 */

import { ipcMain } from 'electron';
import type {
  IPCResult,
  SearchQuery,
  SearchQueryResult,
  SearchSuggestionOptions,
  SearchSuggestionResult,
  RecentSearch,
} from '../../shared/types';
import { getSearchService } from '../search-service';
import { projectStore } from '../project-store';

// IPC channel names for search operations
export const SEARCH_CHANNELS = {
  QUERY: 'search:query',
  SUGGESTIONS: 'search:suggestions',
  IS_ENABLED: 'search:is-enabled',
  GET_RECENT: 'search:get-recent',
  CLEAR_RECENT: 'search:clear-recent',
  REBUILD_INDEX: 'search:rebuild-index',
  VERIFY_FTS5: 'search:verify-fts5',
} as const;

/**
 * Helper to get project path from projectId
 */
function getProjectPath(projectId: string): string | null {
  const project = projectStore.getProject(projectId);
  if (!project) {
    console.warn(`[Search Handlers] Project not found: ${projectId}`);
    return null;
  }
  return project.path;
}

/**
 * Register search IPC handlers
 *
 * Follows the same pattern as history-handlers.ts - simple registration function
 * that sets up all handlers when called.
 */
export function registerSearchHandlers(): void {
  console.log('[Search Handlers] Registering search IPC handlers');

  /**
   * Check if search feature is enabled
   * Returns true if ENABLE_SEARCH is not set to 'false'
   */
  ipcMain.handle(
    SEARCH_CHANNELS.IS_ENABLED,
    async (): Promise<IPCResult<boolean>> => {
      try {
        const service = getSearchService();
        const enabled = service.isEnabled();
        return { success: true, data: enabled };
      } catch (error) {
        console.error('[Search Handlers] Failed to check if search is enabled:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check search status',
        };
      }
    }
  );

  /**
   * Perform full-text search on tasks
   *
   * Uses FTS5 with bm25 ranking for relevance scoring.
   * Supports filtering by status, project, category, priority, tags.
   * Returns results with highlighted matches.
   *
   * @param projectId - Project ID (required)
   * @param query - Search query parameters
   * @returns SearchQueryResult with ranked results and pagination info
   */
  ipcMain.handle(
    SEARCH_CHANNELS.QUERY,
    async (_, projectId: string, query: SearchQuery): Promise<IPCResult<SearchQueryResult>> => {
      console.log('[Search Handlers] QUERY called with:', query?.query);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!query || !query.query) {
        return {
          success: true,
          data: {
            results: [],
            total: 0,
            query: query?.query || '',
            searchTimeMs: 0,
            hasMore: false,
          },
        };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getSearchService();
        const result = service.search(projectPath, query);
        console.log(
          '[Search Handlers] QUERY returning',
          result.results.length,
          'results in',
          result.searchTimeMs,
          'ms'
        );
        return { success: true, data: result };
      } catch (error) {
        console.error('[Search Handlers] Search failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Search failed',
        };
      }
    }
  );

  /**
   * Get autocomplete suggestions for a partial query
   *
   * Returns suggestions from:
   * - Recent searches matching the query
   * - Task titles matching the query
   * - Tags matching the query
   * - Status values matching the query
   *
   * @param projectId - Project ID (required)
   * @param options - Suggestion options (query, limit, includeRecent, projectId)
   * @returns SearchSuggestionResult with suggestions
   */
  ipcMain.handle(
    SEARCH_CHANNELS.SUGGESTIONS,
    async (_, projectId: string, options: SearchSuggestionOptions): Promise<IPCResult<SearchSuggestionResult>> => {
      console.log('[Search Handlers] SUGGESTIONS called with:', options?.query);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!options) {
        return {
          success: true,
          data: {
            suggestions: [],
            query: '',
          },
        };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getSearchService();
        const result = service.getSuggestions(projectPath, options);
        console.log('[Search Handlers] SUGGESTIONS returning', result.suggestions.length, 'suggestions');
        return { success: true, data: result };
      } catch (error) {
        console.error('[Search Handlers] Failed to get suggestions:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get suggestions',
        };
      }
    }
  );

  /**
   * Get recent search history
   *
   * @param limit - Maximum number of recent searches to return (default 10)
   * @returns Array of recent searches
   */
  ipcMain.handle(
    SEARCH_CHANNELS.GET_RECENT,
    async (_, limit: number = 10): Promise<IPCResult<RecentSearch[]>> => {
      console.log('[Search Handlers] GET_RECENT called with limit:', limit);

      try {
        const service = getSearchService();
        const recentSearches = service.getRecentSearches(limit);
        console.log('[Search Handlers] GET_RECENT returning', recentSearches.length, 'searches');
        return { success: true, data: recentSearches };
      } catch (error) {
        console.error('[Search Handlers] Failed to get recent searches:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get recent searches',
        };
      }
    }
  );

  /**
   * Clear recent search history
   */
  ipcMain.handle(
    SEARCH_CHANNELS.CLEAR_RECENT,
    async (): Promise<IPCResult<void>> => {
      console.log('[Search Handlers] CLEAR_RECENT called');

      try {
        const service = getSearchService();
        service.clearRecentSearches();
        console.log('[Search Handlers] CLEAR_RECENT completed');
        return { success: true, data: undefined };
      } catch (error) {
        console.error('[Search Handlers] Failed to clear recent searches:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear recent searches',
        };
      }
    }
  );

  /**
   * Rebuild the FTS5 index
   *
   * Use this if the index becomes corrupted or out of sync.
   * This is a maintenance operation and should be used sparingly.
   *
   * @param projectId - Project ID (required)
   */
  ipcMain.handle(
    SEARCH_CHANNELS.REBUILD_INDEX,
    async (_, projectId: string): Promise<IPCResult<void>> => {
      console.log('[Search Handlers] REBUILD_INDEX called');

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getSearchService();
        service.rebuildIndex(projectPath);
        console.log('[Search Handlers] REBUILD_INDEX completed');
        return { success: true, data: undefined };
      } catch (error) {
        console.error('[Search Handlers] Failed to rebuild FTS index:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rebuild FTS index',
        };
      }
    }
  );

  /**
   * Verify FTS5 is available in SQLite
   *
   * @param projectId - Project ID (required)
   * @returns true if FTS5 is enabled in the SQLite build
   */
  ipcMain.handle(
    SEARCH_CHANNELS.VERIFY_FTS5,
    async (_, projectId: string): Promise<IPCResult<boolean>> => {
      console.log('[Search Handlers] VERIFY_FTS5 called');

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getSearchService();
        const available = service.verifyFts5Available(projectPath);
        console.log('[Search Handlers] VERIFY_FTS5 returning:', available);
        return { success: true, data: available };
      } catch (error) {
        console.error('[Search Handlers] Failed to verify FTS5:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to verify FTS5',
        };
      }
    }
  );

  console.log('[Search Handlers] All search IPC handlers registered successfully');
}
