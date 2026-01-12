/**
 * Full-text search types for FTS5-based task search
 */

import type { TaskStatus, TaskCategory, TaskPriority, TaskComplexity } from './task';

// Sort options for search results
// - 'relevance': Sort by FTS5 bm25 ranking score (default)
// - 'date_desc': Sort by updated date descending (newest first)
// - 'date_asc': Sort by updated date ascending (oldest first)
// - 'title_asc': Sort alphabetically by title
// - 'title_desc': Sort reverse alphabetically by title
export type SearchSortOption = 'relevance' | 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc';

/**
 * Represents a single search result from FTS5 query
 * Includes task data and search-specific metadata
 */
export interface SearchResult {
  id: string;                        // Task ID
  title: string;                     // Task title
  description: string;               // Task description
  status: TaskStatus;                // Current task status
  projectId: string;                 // Project this task belongs to
  specId: string;                    // Spec ID for the task
  score: number;                     // FTS5 bm25 relevance score (lower is better match)
  highlightedTitle?: string;         // Title with search terms highlighted
  highlightedDescription?: string;   // Description with search terms highlighted (snippet)
  matchedFields: string[];           // Which fields matched the query (e.g., ['title', 'description'])
  createdAt: string;                 // ISO timestamp when task was created
  updatedAt: string;                 // ISO timestamp when task was last updated
  // Optional metadata for display
  category?: TaskCategory;           // Task category if set
  priority?: TaskPriority;           // Task priority if set
  complexity?: TaskComplexity;       // Task complexity if set
  tags?: string[];                   // Tags associated with the task
}

/**
 * Database row type for FTS5 search results
 * Used internally for mapping database results to SearchResult
 */
export interface DatabaseSearchRow {
  id: string;
  title: string;
  description: string;
  status: string;
  project_id: string;
  spec_id: string;
  rank: number;                      // FTS5 bm25() returns negative values
  highlighted_title: string | null;
  highlighted_description: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;      // JSON containing category, priority, complexity, tags
}

/**
 * Filters for narrowing search results
 * All filters are optional and combined with AND logic
 */
export interface SearchFilters {
  status?: TaskStatus[];             // Filter by task status (OR within array)
  projectId?: string;                // Filter by project ID
  category?: TaskCategory[];         // Filter by category (OR within array)
  priority?: TaskPriority[];         // Filter by priority (OR within array)
  complexity?: TaskComplexity[];     // Filter by complexity (OR within array)
  tags?: string[];                   // Filter by tags (OR within array)
  dateRange?: {
    start?: string;                  // Filter tasks created/updated after this ISO date
    end?: string;                    // Filter tasks created/updated before this ISO date
  };
  excludeArchived?: boolean;         // Exclude archived tasks (default: true)
}

/**
 * Query parameters for performing a search
 */
export interface SearchQuery {
  query: string;                     // Search query string (FTS5 syntax supported)
  filters?: SearchFilters;           // Optional filters to narrow results
  sort?: SearchSortOption;           // Sort order (default: 'relevance')
  limit?: number;                    // Maximum results to return (default: 50, max: 100)
  offset?: number;                   // Offset for pagination (default: 0)
  highlightTags?: {
    open: string;                    // Opening tag for highlights (e.g., '<mark>')
    close: string;                   // Closing tag for highlights (e.g., '</mark>')
  };
}

/**
 * Result of a search query with pagination info
 */
export interface SearchQueryResult {
  results: SearchResult[];           // Array of matching tasks
  total: number;                     // Total number of matches (for pagination)
  query: string;                     // Original query string
  searchTimeMs: number;              // Time taken to execute search in milliseconds
  hasMore: boolean;                  // Whether more results exist beyond current page
}

/**
 * Autocomplete suggestion for search input
 */
export interface SearchSuggestion {
  text: string;                      // Suggested search text
  type: 'recent' | 'task' | 'tag' | 'status';  // Type of suggestion
  taskId?: string;                   // Task ID if type is 'task'
  count?: number;                    // Number of matches for tag/status suggestions
}

/**
 * Options for getting search suggestions
 */
export interface SearchSuggestionOptions {
  query: string;                     // Partial query to get suggestions for
  limit?: number;                    // Maximum suggestions to return (default: 10)
  includeRecent?: boolean;           // Include recent searches (default: true)
  projectId?: string;                // Limit suggestions to a specific project
}

/**
 * Result of search suggestions request
 */
export interface SearchSuggestionResult {
  suggestions: SearchSuggestion[];   // Array of suggestions
  query: string;                     // Original partial query
}

/**
 * Recent search entry for search history
 */
export interface RecentSearch {
  query: string;                     // Search query that was executed
  timestamp: string;                 // ISO timestamp when search was performed
  resultCount: number;               // Number of results returned
  filters?: SearchFilters;           // Filters used with the search
}

/**
 * Search state for managing search UI
 */
export interface SearchState {
  isOpen: boolean;                   // Whether search modal is open
  query: string;                     // Current query in input
  results: SearchResult[];           // Current search results
  suggestions: SearchSuggestion[];   // Current autocomplete suggestions
  isLoading: boolean;                // Whether a search is in progress
  error?: string;                    // Error message if search failed
  selectedIndex: number;             // Currently selected result index (for keyboard nav)
  recentSearches: RecentSearch[];    // Recent search history
}
