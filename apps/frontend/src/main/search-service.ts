/**
 * Search Service - Full-Text Search with FTS5
 * =============================================
 *
 * Provides full-text search capabilities for tasks using SQLite FTS5.
 * Supports ranked results (bm25), highlighting, filtering, and autocomplete suggestions.
 *
 * Key Features:
 * - Full-text search with FTS5 bm25 ranking (lower score = better match)
 * - Search result highlighting using FTS5 highlight() function
 * - Filter by status, project, category, priority, tags
 * - Autocomplete suggestions for search input
 * - Recent search history tracking
 * - Feature flag support (ENABLE_SEARCH)
 *
 * Usage:
 * ```typescript
 * const service = getSearchService();
 *
 * // Search tasks
 * const results = service.search({
 *   query: 'authentication',
 *   filters: { status: ['backlog', 'in_progress'] },
 *   limit: 20
 * });
 *
 * // Get autocomplete suggestions
 * const suggestions = service.getSuggestions({
 *   query: 'auth',
 *   limit: 10
 * });
 * ```
 */

import type {
  SearchResult,
  SearchQuery,
  SearchQueryResult,
  SearchFilters,
  SearchSuggestion,
  SearchSuggestionOptions,
  SearchSuggestionResult,
  DatabaseSearchRow,
  RecentSearch,
  SearchSortOption,
} from '../shared/types';
import { getDatabaseConnection } from './database';

/**
 * Search Service
 * Handles FTS5 search operations for tasks
 */
export class SearchService {
  private readonly ENABLE_SEARCH: boolean;
  private recentSearches: RecentSearch[] = [];
  private readonly MAX_RECENT_SEARCHES = 20;

  constructor() {
    // Enable search by default
    // Set ENABLE_SEARCH=false to disable search features
    this.ENABLE_SEARCH = process.env.ENABLE_SEARCH !== 'false';
  }

  /**
   * Check if search feature is enabled
   *
   * @returns true if search feature is enabled
   */
  isEnabled(): boolean {
    return this.ENABLE_SEARCH;
  }

  /**
   * Perform a full-text search on tasks
   *
   * @param query - Search query parameters
   * @returns SearchQueryResult with ranked results and pagination info
   */
  search(query: SearchQuery): SearchQueryResult {
    const startTime = Date.now();

    if (!this.ENABLE_SEARCH) {
      return {
        results: [],
        total: 0,
        query: query.query,
        searchTimeMs: 0,
        hasMore: false,
      };
    }

    if (!query.query || query.query.trim() === '') {
      return {
        results: [],
        total: 0,
        query: query.query,
        searchTimeMs: Date.now() - startTime,
        hasMore: false,
      };
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const limit = Math.min(query.limit ?? 50, 100);
      const offset = query.offset ?? 0;
      const sort = query.sort ?? 'relevance';

      // Prepare highlight tags
      const openTag = query.highlightTags?.open ?? '<mark>';
      const closeTag = query.highlightTags?.close ?? '</mark>';

      // Escape the query for FTS5 (handle special characters)
      const escapedQuery = this.escapeFtsQuery(query.query);

      // Build the base search query with FTS5
      // Using MATCH for full-text search and bm25() for ranking
      const { whereClause, params } = this.buildFilterClause(query.filters);

      // Build ORDER BY clause based on sort option
      const orderByClause = this.buildOrderByClause(sort);

      // Get total count for pagination (without limit/offset)
      const countQuery = `
        SELECT COUNT(*) as count
        FROM tasks t
        INNER JOIN tasks_fts fts ON t.rowid = fts.rowid
        WHERE tasks_fts MATCH ?
        ${whereClause ? 'AND ' + whereClause : ''}
      `;
      const countParams = [escapedQuery, ...params];
      const countStmt = db.prepare(countQuery);
      const countResult = countStmt.get(...countParams) as { count: number };
      const total = countResult.count;

      // Get search results with highlighting and ranking
      const searchQuery = `
        SELECT
          t.id,
          t.title,
          t.description,
          t.status,
          t.project_id,
          t.spec_id,
          bm25(tasks_fts) as rank,
          highlight(tasks_fts, 0, ?, ?) as highlighted_title,
          highlight(tasks_fts, 1, ?, ?) as highlighted_description,
          t.created_at,
          t.updated_at,
          t.metadata_json
        FROM tasks t
        INNER JOIN tasks_fts fts ON t.rowid = fts.rowid
        WHERE tasks_fts MATCH ?
        ${whereClause ? 'AND ' + whereClause : ''}
        ${orderByClause}
        LIMIT ? OFFSET ?
      `;
      const searchParams = [
        openTag, closeTag,
        openTag, closeTag,
        escapedQuery,
        ...params,
        limit,
        offset,
      ];

      const stmt = db.prepare(searchQuery);
      const rows = stmt.all(...searchParams) as DatabaseSearchRow[];

      const results = rows.map((row) => this.rowToResult(row, query.query));

      const searchTimeMs = Date.now() - startTime;

      // Store in recent searches
      this.addRecentSearch(query.query, total, query.filters);

      return {
        results,
        total,
        query: query.query,
        searchTimeMs,
        hasMore: offset + results.length < total,
      };
    } catch (error) {
      console.error('[SearchService] Search failed:', error);
      return {
        results: [],
        total: 0,
        query: query.query,
        searchTimeMs: Date.now() - startTime,
        hasMore: false,
      };
    }
  }

  /**
   * Get autocomplete suggestions for a partial query
   *
   * @param options - Suggestion options
   * @returns SearchSuggestionResult with suggestions
   */
  getSuggestions(options: SearchSuggestionOptions): SearchSuggestionResult {
    if (!this.ENABLE_SEARCH) {
      return { suggestions: [], query: options.query };
    }

    const suggestions: SearchSuggestion[] = [];
    const limit = options.limit ?? 10;
    const query = options.query?.trim() ?? '';

    try {
      const db = getDatabaseConnection().getConnection();

      // 1. Include recent searches if requested (default: true)
      if (options.includeRecent !== false && query.length > 0) {
        const recentMatches = this.recentSearches
          .filter((r) => r.query.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 3)
          .map((r) => ({
            text: r.query,
            type: 'recent' as const,
            count: r.resultCount,
          }));
        suggestions.push(...recentMatches);
      }

      // 2. Search for matching task titles
      if (query.length >= 2) {
        let titleQuery = `
          SELECT id, title
          FROM tasks
          WHERE title LIKE ?
        `;
        const titleParams: unknown[] = [`%${query}%`];

        if (options.projectId) {
          titleQuery += ' AND project_id = ?';
          titleParams.push(options.projectId);
        }

        titleQuery += ' ORDER BY updated_at DESC LIMIT ?';
        titleParams.push(Math.max(0, limit - suggestions.length));

        const titleStmt = db.prepare(titleQuery);
        const titleRows = titleStmt.all(...titleParams) as { id: string; title: string }[];

        const taskSuggestions: SearchSuggestion[] = titleRows.map((row) => ({
          text: row.title,
          type: 'task' as const,
          taskId: row.id,
        }));
        suggestions.push(...taskSuggestions);
      }

      // 3. Search for matching tags
      if (query.length >= 2 && suggestions.length < limit) {
        const tagQuery = `
          SELECT DISTINCT
            json_each.value as tag,
            COUNT(*) as count
          FROM tasks, json_each(json_extract(metadata_json, '$.tags'))
          WHERE json_each.value LIKE ?
          GROUP BY json_each.value
          ORDER BY count DESC
          LIMIT ?
        `;
        const tagStmt = db.prepare(tagQuery);
        const tagRows = tagStmt.all(`%${query}%`, Math.max(0, limit - suggestions.length)) as { tag: string; count: number }[];

        const tagSuggestions: SearchSuggestion[] = tagRows.map((row) => ({
          text: row.tag,
          type: 'tag' as const,
          count: row.count,
        }));
        suggestions.push(...tagSuggestions);
      }

      // 4. Suggest status filters if query matches a status
      const statusMatches = ['backlog', 'in_progress', 'ai_review', 'human_review', 'done']
        .filter((s) => s.includes(query.toLowerCase()));

      if (statusMatches.length > 0 && suggestions.length < limit) {
        for (const status of statusMatches.slice(0, limit - suggestions.length)) {
          // Get count of tasks with this status
          const countStmt = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?');
          const countResult = countStmt.get(status) as { count: number };

          suggestions.push({
            text: `status:${status}`,
            type: 'status' as const,
            count: countResult.count,
          });
        }
      }

      return {
        suggestions: suggestions.slice(0, limit),
        query: options.query,
      };
    } catch (error) {
      console.error('[SearchService] Failed to get suggestions:', error);
      return { suggestions: [], query: options.query };
    }
  }

  /**
   * Get recent search history
   *
   * @param limit - Maximum number of recent searches to return
   * @returns Array of recent searches
   */
  getRecentSearches(limit: number = 10): RecentSearch[] {
    return this.recentSearches.slice(0, limit);
  }

  /**
   * Clear recent search history
   */
  clearRecentSearches(): void {
    this.recentSearches = [];
  }

  /**
   * Rebuild the FTS5 index
   *
   * Use this if the index becomes corrupted or out of sync.
   * This is a maintenance operation and should be used sparingly.
   */
  rebuildIndex(): void {
    if (!this.ENABLE_SEARCH) {
      return;
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // FTS5 rebuild command
      db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')");
    } catch (error) {
      console.error('[SearchService] Failed to rebuild FTS index:', error);
      throw error;
    }
  }

  /**
   * Verify FTS5 is enabled in the SQLite build
   *
   * @returns true if FTS5 is available
   */
  verifyFts5Available(): boolean {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') as enabled");
      const result = stmt.get() as { enabled: number };
      return result.enabled === 1;
    } catch (error) {
      console.error('[SearchService] Failed to verify FTS5:', error);
      return false;
    }
  }

  /**
   * Escape a query string for FTS5
   *
   * Handles special characters that have meaning in FTS5 syntax.
   *
   * @param query - Raw query string
   * @returns Escaped query string safe for FTS5 MATCH
   */
  private escapeFtsQuery(query: string): string {
    // Remove or escape FTS5 special characters: + - * " ^ ~ : ( )
    // For simple search, wrap terms in double quotes to treat as phrases
    // and escape internal quotes
    const trimmed = query.trim();

    // If query contains explicit FTS5 syntax (AND, OR, NOT, NEAR), allow it
    if (/\b(AND|OR|NOT|NEAR)\b/i.test(trimmed)) {
      return trimmed;
    }

    // For simple queries, escape special characters
    // and add * for prefix matching on the last word
    const escaped = trimmed
      .replace(/"/g, '""') // Escape quotes
      .replace(/[+\-^~:()]/g, ' ') // Replace operators with space
      .trim();

    // Add prefix matching (*) to the last word for better UX
    const words = escaped.split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      words[words.length - 1] = words[words.length - 1] + '*';
    }

    return words.join(' ');
  }

  /**
   * Build WHERE clause from filters
   *
   * @param filters - Search filters
   * @returns Object with whereClause string and params array
   */
  private buildFilterClause(filters?: SearchFilters): { whereClause: string; params: unknown[] } {
    if (!filters) {
      return { whereClause: '', params: [] };
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Status filter (OR within array)
    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => '?').join(', ');
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...filters.status);
    }

    // Project filter
    if (filters.projectId) {
      conditions.push('t.project_id = ?');
      params.push(filters.projectId);
    }

    // Date range filter
    if (filters.dateRange?.start) {
      conditions.push('t.updated_at >= ?');
      params.push(filters.dateRange.start);
    }
    if (filters.dateRange?.end) {
      conditions.push('t.updated_at <= ?');
      params.push(filters.dateRange.end);
    }

    // Exclude archived (default: true)
    if (filters.excludeArchived !== false) {
      conditions.push("t.metadata_json NOT LIKE '%\"archivedAt\"%'");
    }

    // Category filter (stored in metadata_json)
    if (filters.category && filters.category.length > 0) {
      const categoryConditions = filters.category
        .map(() => "json_extract(t.metadata_json, '$.category') = ?")
        .join(' OR ');
      conditions.push(`(${categoryConditions})`);
      params.push(...filters.category);
    }

    // Priority filter (stored in metadata_json)
    if (filters.priority && filters.priority.length > 0) {
      const priorityConditions = filters.priority
        .map(() => "json_extract(t.metadata_json, '$.priority') = ?")
        .join(' OR ');
      conditions.push(`(${priorityConditions})`);
      params.push(...filters.priority);
    }

    // Complexity filter (stored in metadata_json)
    if (filters.complexity && filters.complexity.length > 0) {
      const complexityConditions = filters.complexity
        .map(() => "json_extract(t.metadata_json, '$.complexity') = ?")
        .join(' OR ');
      conditions.push(`(${complexityConditions})`);
      params.push(...filters.complexity);
    }

    // Tags filter (stored in metadata_json as array)
    if (filters.tags && filters.tags.length > 0) {
      // Check if any of the filter tags exist in the task's tags array
      const tagConditions = filters.tags
        .map(() => "EXISTS (SELECT 1 FROM json_each(json_extract(t.metadata_json, '$.tags')) WHERE value = ?)")
        .join(' OR ');
      conditions.push(`(${tagConditions})`);
      params.push(...filters.tags);
    }

    return {
      whereClause: conditions.length > 0 ? conditions.join(' AND ') : '',
      params,
    };
  }

  /**
   * Build ORDER BY clause based on sort option
   *
   * @param sort - Sort option
   * @returns ORDER BY clause string
   */
  private buildOrderByClause(sort: SearchSortOption): string {
    switch (sort) {
      case 'relevance':
        // bm25() returns negative values, so lower (more negative) is better
        return 'ORDER BY rank';
      case 'date_desc':
        return 'ORDER BY t.updated_at DESC';
      case 'date_asc':
        return 'ORDER BY t.updated_at ASC';
      case 'title_asc':
        return 'ORDER BY t.title ASC';
      case 'title_desc':
        return 'ORDER BY t.title DESC';
      default:
        return 'ORDER BY rank';
    }
  }

  /**
   * Convert database row to SearchResult object
   *
   * @param row - Database row from search query
   * @param originalQuery - Original search query for matched fields detection
   * @returns SearchResult object
   */
  private rowToResult(row: DatabaseSearchRow, originalQuery: string): SearchResult {
    // Parse metadata JSON for optional fields
    let category: SearchResult['category'];
    let priority: SearchResult['priority'];
    let complexity: SearchResult['complexity'];
    let tags: string[] | undefined;

    if (row.metadata_json) {
      try {
        const metadata = JSON.parse(row.metadata_json);
        category = metadata.category;
        priority = metadata.priority;
        complexity = metadata.complexity;
        tags = metadata.tags;
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Determine which fields matched
    const matchedFields: string[] = [];
    const queryLower = originalQuery.toLowerCase();
    if (row.title.toLowerCase().includes(queryLower)) {
      matchedFields.push('title');
    }
    if (row.description.toLowerCase().includes(queryLower)) {
      matchedFields.push('description');
    }
    if (tags?.some((tag) => tag.toLowerCase().includes(queryLower))) {
      matchedFields.push('tags');
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status as SearchResult['status'],
      projectId: row.project_id,
      specId: row.spec_id,
      score: row.rank, // bm25 score (negative, lower is better)
      highlightedTitle: row.highlighted_title || undefined,
      highlightedDescription: row.highlighted_description || undefined,
      matchedFields,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      category,
      priority,
      complexity,
      tags,
    };
  }

  /**
   * Add a search to recent history
   *
   * @param query - Search query
   * @param resultCount - Number of results returned
   * @param filters - Filters used
   */
  private addRecentSearch(query: string, resultCount: number, filters?: SearchFilters): void {
    // Remove duplicate if exists
    this.recentSearches = this.recentSearches.filter((r) => r.query !== query);

    // Add to front
    this.recentSearches.unshift({
      query,
      timestamp: new Date().toISOString(),
      resultCount,
      filters,
    });

    // Trim to max size
    if (this.recentSearches.length > this.MAX_RECENT_SEARCHES) {
      this.recentSearches = this.recentSearches.slice(0, this.MAX_RECENT_SEARCHES);
    }
  }
}

// Singleton instance
let _instance: SearchService | null = null;

/**
 * Get the singleton SearchService instance
 *
 * @returns SearchService instance
 */
export function getSearchService(): SearchService {
  if (!_instance) {
    _instance = new SearchService();
  }
  return _instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetSearchService(): void {
  _instance = null;
}
