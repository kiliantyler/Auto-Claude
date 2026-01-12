import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  SearchQuery,
  SearchQueryResult,
  SearchSuggestionOptions,
  SearchSuggestionResult,
  RecentSearch,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Search API operations for FTS5 full-text search
 * Phase 4B - Full-Text Search
 */
export interface SearchAPI {
  // Core Search Operations
  search: (query: SearchQuery) => Promise<IPCResult<SearchQueryResult>>;
  getSuggestions: (options: SearchSuggestionOptions) => Promise<IPCResult<SearchSuggestionResult>>;

  // Feature Flag
  isEnabled: () => Promise<IPCResult<boolean>>;

  // FTS5 Verification
  verifyFts5: () => Promise<IPCResult<boolean>>;

  // Recent Searches
  getRecentSearches: (limit?: number) => Promise<IPCResult<RecentSearch[]>>;
  clearRecentSearches: () => Promise<IPCResult<void>>;

  // Index Maintenance
  rebuildIndex: () => Promise<IPCResult<void>>;
}

/**
 * Creates the Search API implementation
 */
export const createSearchAPI = (): SearchAPI => ({
  // Core Search Operations
  search: (query: SearchQuery): Promise<IPCResult<SearchQueryResult>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_QUERY, query),

  getSuggestions: (options: SearchSuggestionOptions): Promise<IPCResult<SearchSuggestionResult>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_SUGGESTIONS, options),

  // Feature Flag
  isEnabled: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_IS_ENABLED),

  // FTS5 Verification
  verifyFts5: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_VERIFY_FTS5),

  // Recent Searches
  getRecentSearches: (limit?: number): Promise<IPCResult<RecentSearch[]>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_GET_RECENT, limit),

  clearRecentSearches: (): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_CLEAR_RECENT),

  // Index Maintenance
  rebuildIndex: (): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.SEARCH_REBUILD_INDEX)
});
