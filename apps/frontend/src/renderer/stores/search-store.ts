import { create } from 'zustand';
import type {
  SearchResult,
  SearchSuggestion,
  SearchFilters,
  SearchQuery,
  SearchQueryResult,
  SearchSortOption,
  RecentSearch
} from '../../shared/types';

interface SearchState {
  // Modal state
  isOpen: boolean;
  // Search query and results
  query: string;
  results: SearchResult[];
  total: number;
  // Suggestions for autocomplete
  suggestions: SearchSuggestion[];
  showSuggestions: boolean;
  // Filters and sort
  filters: SearchFilters | null;
  sort: SearchSortOption;
  // Pagination
  offset: number;
  hasMore: boolean;
  // Loading and error states
  isLoading: boolean;
  isLoadingSuggestions: boolean;
  error: string | null;
  // Navigation
  selectedIndex: number;
  // Recent searches
  recentSearches: RecentSearch[];
  // Performance tracking
  lastSearchTimeMs: number | null;
  // Feature flag
  isEnabled: boolean;

  // Actions
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setResults: (results: SearchResult[], total: number, hasMore: boolean) => void;
  appendResults: (results: SearchResult[]) => void;
  setSuggestions: (suggestions: SearchSuggestion[]) => void;
  setShowSuggestions: (show: boolean) => void;
  setFilters: (filters: SearchFilters | null) => void;
  setSort: (sort: SearchSortOption) => void;
  setOffset: (offset: number) => void;
  setLoading: (loading: boolean) => void;
  setLoadingSuggestions: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSelectedIndex: (index: number) => void;
  incrementSelectedIndex: () => void;
  decrementSelectedIndex: () => void;
  setRecentSearches: (searches: RecentSearch[]) => void;
  addRecentSearch: (search: RecentSearch) => void;
  setLastSearchTime: (timeMs: number) => void;
  setEnabled: (enabled: boolean) => void;
  clearResults: () => void;
  clearAll: () => void;
  reset: () => void;

  // Selectors
  getSelectedItem: () => SearchResult | SearchSuggestion | null;
  getCombinedItems: () => (SearchResult | SearchSuggestion)[];
  getFilterCount: () => number;
}

const initialState = {
  isOpen: false,
  query: '',
  results: [],
  total: 0,
  suggestions: [],
  showSuggestions: true,
  filters: null,
  sort: 'relevance' as SearchSortOption,
  offset: 0,
  hasMore: false,
  isLoading: false,
  isLoadingSuggestions: false,
  error: null,
  selectedIndex: 0,
  recentSearches: [],
  lastSearchTimeMs: null,
  isEnabled: false,
};

export const useSearchStore = create<SearchState>((set, get) => ({
  ...initialState,

  setOpen: (isOpen) =>
    set((state) => {
      // Reset search state when closing
      if (!isOpen) {
        return {
          isOpen,
          query: '',
          results: [],
          total: 0,
          suggestions: [],
          showSuggestions: true,
          error: null,
          selectedIndex: 0,
          offset: 0,
          hasMore: false,
        };
      }
      return { isOpen };
    }),

  setQuery: (query) =>
    set({
      query,
      selectedIndex: 0,
      error: null,
    }),

  setResults: (results, total, hasMore) =>
    set({
      results,
      total,
      hasMore,
      showSuggestions: false,
      selectedIndex: 0,
    }),

  appendResults: (newResults) =>
    set((state) => ({
      results: [...state.results, ...newResults],
      offset: state.offset + newResults.length,
    })),

  setSuggestions: (suggestions) => set({ suggestions }),

  setShowSuggestions: (showSuggestions) => set({ showSuggestions }),

  setFilters: (filters) =>
    set({
      filters,
      offset: 0,
      results: [],
      total: 0,
    }),

  setSort: (sort) =>
    set({
      sort,
      offset: 0,
      results: [],
      total: 0,
    }),

  setOffset: (offset) => set({ offset }),

  setLoading: (isLoading) => set({ isLoading }),

  setLoadingSuggestions: (isLoadingSuggestions) => set({ isLoadingSuggestions }),

  setError: (error) => set({ error, isLoading: false }),

  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),

  incrementSelectedIndex: () =>
    set((state) => {
      const items = state.getCombinedItems();
      const maxIndex = items.length - 1;
      return {
        selectedIndex: state.selectedIndex < maxIndex ? state.selectedIndex + 1 : 0,
      };
    }),

  decrementSelectedIndex: () =>
    set((state) => {
      const items = state.getCombinedItems();
      const maxIndex = items.length - 1;
      return {
        selectedIndex: state.selectedIndex > 0 ? state.selectedIndex - 1 : maxIndex,
      };
    }),

  setRecentSearches: (recentSearches) => set({ recentSearches }),

  addRecentSearch: (search) =>
    set((state) => {
      // Remove duplicates and add new search at the beginning
      const filtered = state.recentSearches.filter((s) => s.query !== search.query);
      const updated = [search, ...filtered].slice(0, 10); // Keep max 10 recent searches
      return { recentSearches: updated };
    }),

  setLastSearchTime: (lastSearchTimeMs) => set({ lastSearchTimeMs }),

  setEnabled: (isEnabled) => set({ isEnabled }),

  clearResults: () =>
    set({
      results: [],
      total: 0,
      hasMore: false,
      offset: 0,
      showSuggestions: true,
      selectedIndex: 0,
    }),

  clearAll: () =>
    set({
      query: '',
      results: [],
      total: 0,
      suggestions: [],
      showSuggestions: true,
      filters: null,
      sort: 'relevance',
      offset: 0,
      hasMore: false,
      error: null,
      selectedIndex: 0,
      lastSearchTimeMs: null,
    }),

  reset: () => set(initialState),

  getSelectedItem: () => {
    const state = get();
    const items = state.getCombinedItems();
    if (state.selectedIndex >= 0 && state.selectedIndex < items.length) {
      return items[state.selectedIndex];
    }
    return null;
  },

  getCombinedItems: () => {
    const state = get();
    // Show suggestions when no results and suggestions are enabled
    if (state.showSuggestions && state.suggestions.length > 0 && state.results.length === 0) {
      return state.suggestions;
    }
    return state.results;
  },

  getFilterCount: () => {
    const state = get();
    if (!state.filters) return 0;
    let count = 0;
    if (state.filters.status?.length) count++;
    if (state.filters.category?.length) count++;
    if (state.filters.priority?.length) count++;
    if (state.filters.complexity?.length) count++;
    if (state.filters.tags?.length) count++;
    if (state.filters.dateRange?.start || state.filters.dateRange?.end) count++;
    if (state.filters.projectId) count++;
    return count;
  },
}));

// ============================================
// Async Actions (outside store for cleaner API)
// ============================================

/**
 * Check if search feature is enabled
 */
export async function checkSearchEnabled(): Promise<boolean> {
  const store = useSearchStore.getState();

  try {
    const result = await window.electronAPI.isSearchEnabled();
    if (result.success && result.data !== undefined) {
      store.setEnabled(result.data);
      return result.data;
    }
    return false;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to check search status');
    return false;
  }
}

/**
 * Perform a search query
 */
export async function performSearch(options?: {
  query?: string;
  filters?: SearchFilters;
  sort?: SearchSortOption;
  limit?: number;
  offset?: number;
  projectId?: string;
}): Promise<SearchQueryResult | null> {
  const store = useSearchStore.getState();
  const query = options?.query ?? store.query;

  if (!query.trim()) {
    store.clearResults();
    return null;
  }

  store.setLoading(true);
  store.setError(null);

  try {
    const searchQuery: SearchQuery = {
      query,
      filters: options?.filters ?? store.filters ?? undefined,
      sort: options?.sort ?? store.sort,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
      highlightTags: {
        open: '<mark>',
        close: '</mark>',
      },
    };

    // Add project filter if provided
    if (options?.projectId) {
      searchQuery.filters = {
        ...searchQuery.filters,
        projectId: options.projectId,
      };
    }

    const result = await window.electronAPI.search(searchQuery);

    if (result.success && result.data) {
      const { results, total, hasMore, searchTimeMs } = result.data;

      if (options?.offset && options.offset > 0) {
        // Append results for pagination
        store.appendResults(results);
      } else {
        // Replace results for new search
        store.setResults(results, total, hasMore);
      }

      store.setLastSearchTime(searchTimeMs);

      // Add to recent searches
      store.addRecentSearch({
        query,
        timestamp: new Date().toISOString(),
        resultCount: total,
        filters: searchQuery.filters,
      });

      return result.data;
    } else {
      store.setError(result.error || 'Search failed');
      return null;
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error during search');
    return null;
  } finally {
    store.setLoading(false);
  }
}

/**
 * Load more results (pagination)
 */
export async function loadMoreResults(): Promise<void> {
  const store = useSearchStore.getState();

  if (!store.hasMore || store.isLoading) {
    return;
  }

  await performSearch({
    offset: store.results.length,
  });
}

/**
 * Fetch autocomplete suggestions
 */
export async function fetchSuggestions(
  partialQuery: string,
  options?: { projectId?: string; limit?: number }
): Promise<void> {
  const store = useSearchStore.getState();

  if (!partialQuery.trim() || partialQuery.length < 2) {
    store.setSuggestions([]);
    return;
  }

  store.setLoadingSuggestions(true);

  try {
    const result = await window.electronAPI.getSuggestions({
      query: partialQuery,
      limit: options?.limit ?? 8,
      includeRecent: true,
      ...(options?.projectId && { projectId: options.projectId }),
    });

    if (result.success && result.data) {
      store.setSuggestions(result.data.suggestions);
    }
  } catch {
    // Silently fail - suggestions are not critical
  } finally {
    store.setLoadingSuggestions(false);
  }
}

/**
 * Load recent searches
 */
export async function loadRecentSearches(limit?: number): Promise<void> {
  const store = useSearchStore.getState();

  try {
    const result = await window.electronAPI.getRecentSearches(limit ?? 10);

    if (result.success && result.data) {
      store.setRecentSearches(result.data);

      // Also set as initial suggestions
      const recentSuggestions: SearchSuggestion[] = result.data.map((recent) => ({
        text: recent.query,
        type: 'recent' as const,
        count: recent.resultCount,
      }));
      store.setSuggestions(recentSuggestions);
    }
  } catch {
    // Silently fail - recent searches are not critical
  }
}

/**
 * Clear recent search history
 */
export async function clearRecentSearches(): Promise<void> {
  const store = useSearchStore.getState();

  try {
    await window.electronAPI.clearRecentSearches();
    store.setRecentSearches([]);
    store.setSuggestions([]);
  } catch {
    // Silently fail
  }
}

/**
 * Save a search to recent searches
 */
export async function saveRecentSearch(search: RecentSearch): Promise<void> {
  try {
    await window.electronAPI.saveRecentSearch(search);
    useSearchStore.getState().addRecentSearch(search);
  } catch {
    // Silently fail - saving recent search is not critical
  }
}

/**
 * Open the global search modal
 */
export function openSearch(): void {
  const store = useSearchStore.getState();
  store.setOpen(true);
  loadRecentSearches();
}

/**
 * Close the global search modal
 */
export function closeSearch(): void {
  useSearchStore.getState().setOpen(false);
}

/**
 * Toggle the global search modal
 */
export function toggleSearch(): void {
  const store = useSearchStore.getState();
  if (store.isOpen) {
    closeSearch();
  } else {
    openSearch();
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if an item is a SearchResult (vs SearchSuggestion)
 */
export function isSearchResult(item: SearchResult | SearchSuggestion): item is SearchResult {
  return 'id' in item && 'title' in item && 'status' in item;
}

/**
 * Check if an item is a SearchSuggestion
 */
export function isSearchSuggestion(item: SearchResult | SearchSuggestion): item is SearchSuggestion {
  return 'text' in item && 'type' in item;
}

/**
 * Format search time for display
 */
export function formatSearchTime(timeMs: number): string {
  if (timeMs < 1) {
    return '<1ms';
  }
  if (timeMs < 1000) {
    return `${Math.round(timeMs)}ms`;
  }
  return `${(timeMs / 1000).toFixed(2)}s`;
}

/**
 * Get icon name for suggestion type
 */
export function getSuggestionIcon(type: SearchSuggestion['type']): string {
  switch (type) {
    case 'recent':
      return 'clock';
    case 'task':
      return 'file-text';
    case 'tag':
      return 'tag';
    case 'status':
      return 'circle';
    default:
      return 'search';
  }
}

/**
 * Get display label for sort option
 */
export function getSortLabel(sort: SearchSortOption): string {
  switch (sort) {
    case 'relevance':
      return 'Relevance';
    case 'date_desc':
      return 'Newest First';
    case 'date_asc':
      return 'Oldest First';
    case 'title_asc':
      return 'Title A-Z';
    case 'title_desc':
      return 'Title Z-A';
    default:
      return sort;
  }
}

/**
 * Truncate description for display
 */
export function truncateDescription(description: string, maxLength = 150): string {
  if (!description) return '';
  if (description.length <= maxLength) return description;
  return description.substring(0, maxLength).trim() + '...';
}

/**
 * Build filter summary string for display
 */
export function buildFilterSummary(filters: SearchFilters | null): string {
  if (!filters) return '';

  const parts: string[] = [];

  if (filters.status?.length) {
    parts.push(`Status: ${filters.status.join(', ')}`);
  }
  if (filters.category?.length) {
    parts.push(`Category: ${filters.category.join(', ')}`);
  }
  if (filters.priority?.length) {
    parts.push(`Priority: ${filters.priority.join(', ')}`);
  }
  if (filters.tags?.length) {
    parts.push(`Tags: ${filters.tags.join(', ')}`);
  }
  if (filters.dateRange?.start || filters.dateRange?.end) {
    const start = filters.dateRange.start ? new Date(filters.dateRange.start).toLocaleDateString() : 'any';
    const end = filters.dateRange.end ? new Date(filters.dateRange.end).toLocaleDateString() : 'any';
    parts.push(`Date: ${start} - ${end}`);
  }

  return parts.join(' | ');
}
