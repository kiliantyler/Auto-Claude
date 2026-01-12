import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, X, FileText, Clock, Tag, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SearchResult, SearchSuggestion, SearchQuery } from '../../../shared/types';

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResultSelect?: (result: SearchResult) => void;
  projectId?: string;
}

interface SearchState {
  query: string;
  results: SearchResult[];
  suggestions: SearchSuggestion[];
  isLoading: boolean;
  error: string | null;
  selectedIndex: number;
  showSuggestions: boolean;
}

const initialState: SearchState = {
  query: '',
  results: [],
  suggestions: [],
  isLoading: false,
  error: null,
  selectedIndex: 0,
  showSuggestions: true,
};

/**
 * GlobalSearch - Full-text search modal with keyboard navigation
 *
 * Features:
 * - FTS5-powered search with bm25 ranking
 * - Autocomplete suggestions
 * - Keyboard navigation (arrow keys, enter, escape)
 * - Result highlighting
 * - Recent search history
 *
 * Usage:
 * - Open with Cmd/Ctrl+K from anywhere in the app
 * - Type to search, use arrow keys to navigate
 * - Enter to select, Escape to close
 */
export function GlobalSearch({
  open,
  onOpenChange,
  onResultSelect,
  projectId,
}: GlobalSearchProps) {
  const [state, setState] = useState<SearchState>(initialState);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Combined list of suggestions and results for navigation
  const combinedItems = state.showSuggestions && state.suggestions.length > 0 && !state.results.length
    ? state.suggestions
    : state.results;

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setState(initialState);
      // Focus input after a short delay to ensure dialog is mounted
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      // Load recent searches
      loadRecentSearches();
    }
  }, [open]);

  // Load recent searches as initial suggestions
  const loadRecentSearches = useCallback(async () => {
    try {
      const result = await window.electronAPI.getRecentSearches(5);
      if (result.success && result.data) {
        const recentSuggestions: SearchSuggestion[] = result.data.map((recent) => ({
          text: recent.query,
          type: 'recent' as const,
          count: recent.resultCount,
        }));
        setState((prev) => ({
          ...prev,
          suggestions: recentSuggestions,
        }));
      }
    } catch {
      // Silently fail - recent searches are not critical
    }
  }, []);

  // Debounced search
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setState((prev) => ({
        ...prev,
        results: [],
        isLoading: false,
        showSuggestions: true,
      }));
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const query: SearchQuery = {
        query: searchQuery,
        limit: 20,
        highlightTags: {
          open: '<mark>',
          close: '</mark>',
        },
        ...(projectId && { filters: { projectId } }),
      };

      const result = await window.electronAPI.search(query);

      if (result.success && result.data) {
        setState((prev) => ({
          ...prev,
          results: result.data!.results,
          isLoading: false,
          showSuggestions: false,
          selectedIndex: 0,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          error: result.error || 'Search failed',
          isLoading: false,
        }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Search failed',
        isLoading: false,
      }));
    }
  }, [projectId]);

  // Fetch suggestions for autocomplete
  const fetchSuggestions = useCallback(async (partialQuery: string) => {
    if (!partialQuery.trim() || partialQuery.length < 2) {
      return;
    }

    try {
      const result = await window.electronAPI.getSuggestions({
        query: partialQuery,
        limit: 8,
        includeRecent: true,
        ...(projectId && { projectId }),
      });

      if (result.success && result.data) {
        setState((prev) => ({
          ...prev,
          suggestions: result.data!.suggestions,
        }));
      }
    } catch {
      // Silently fail - suggestions are not critical
    }
  }, [projectId]);

  // Handle input change with debouncing
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setState((prev) => ({ ...prev, query: value, selectedIndex: 0 }));

    // Clear existing debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Debounce the search
    debounceRef.current = setTimeout(() => {
      if (value.length >= 2) {
        fetchSuggestions(value);
      }
      if (value.length >= 3) {
        performSearch(value);
      } else if (!value) {
        loadRecentSearches();
        setState((prev) => ({ ...prev, results: [], showSuggestions: true }));
      }
    }, 150);
  }, [performSearch, fetchSuggestions, loadRecentSearches]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const itemCount = combinedItems.length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex: prev.selectedIndex < itemCount - 1 ? prev.selectedIndex + 1 : 0,
        }));
        break;

      case 'ArrowUp':
        e.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex: prev.selectedIndex > 0 ? prev.selectedIndex - 1 : itemCount - 1,
        }));
        break;

      case 'Enter':
        e.preventDefault();
        if (itemCount > 0 && state.selectedIndex >= 0) {
          const selectedItem = combinedItems[state.selectedIndex];
          if (isSearchResult(selectedItem)) {
            onResultSelect?.(selectedItem);
            onOpenChange(false);
          } else {
            // It's a suggestion - use it as search query
            setState((prev) => ({ ...prev, query: selectedItem.text }));
            performSearch(selectedItem.text);
          }
        } else if (state.query.trim()) {
          // No selection but has query - perform search
          performSearch(state.query);
        }
        break;

      case 'Escape':
        e.preventDefault();
        onOpenChange(false);
        break;

      case 'Tab':
        // Allow tab to autocomplete from first suggestion
        if (state.suggestions.length > 0 && state.showSuggestions) {
          e.preventDefault();
          const firstSuggestion = state.suggestions[0];
          setState((prev) => ({ ...prev, query: firstSuggestion.text }));
          performSearch(firstSuggestion.text);
        }
        break;
    }
  }, [combinedItems, state.selectedIndex, state.query, state.suggestions, state.showSuggestions, performSearch, onResultSelect, onOpenChange]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && combinedItems.length > 0) {
      const selectedElement = listRef.current.querySelector(`[data-index="${state.selectedIndex}"]`);
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [state.selectedIndex, combinedItems.length]);

  // Handle result click
  const handleResultClick = useCallback((result: SearchResult) => {
    onResultSelect?.(result);
    onOpenChange(false);
  }, [onResultSelect, onOpenChange]);

  // Handle suggestion click
  const handleSuggestionClick = useCallback((suggestion: SearchSuggestion) => {
    setState((prev) => ({ ...prev, query: suggestion.text }));
    performSearch(suggestion.text);
    inputRef.current?.focus();
  }, [performSearch]);

  // Clear search
  const handleClear = useCallback(() => {
    setState(initialState);
    loadRecentSearches();
    inputRef.current?.focus();
  }, [loadRecentSearches]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-[50%] top-[20%] z-50 w-full max-w-2xl',
            'translate-x-[-50%]',
            'bg-card border border-border rounded-xl',
            'shadow-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
            'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
            'duration-200 overflow-hidden flex flex-col max-h-[70vh]'
          )}
          onKeyDown={handleKeyDown}
        >
          {/* Search Input */}
          <div className="flex items-center gap-3 p-4 border-b border-border">
            {state.isLoading ? (
              <Loader2 className="h-5 w-5 text-muted-foreground animate-spin flex-shrink-0" />
            ) : (
              <Search className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            )}
            <input
              ref={inputRef}
              type="text"
              value={state.query}
              onChange={handleInputChange}
              placeholder="Search tasks..."
              className={cn(
                'flex-1 bg-transparent text-foreground text-base',
                'placeholder:text-muted-foreground',
                'focus:outline-none'
              )}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {state.query && (
              <button
                onClick={handleClear}
                className={cn(
                  'p-1 rounded-md',
                  'text-muted-foreground hover:text-foreground',
                  'hover:bg-accent transition-colors'
                )}
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">esc</kbd>
              <span>to close</span>
            </div>
          </div>

          {/* Results/Suggestions List */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto p-2"
            role="listbox"
            aria-label="Search results"
          >
            {/* Error State */}
            {state.error && (
              <div className="flex items-center gap-3 px-4 py-8 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span>{state.error}</span>
              </div>
            )}

            {/* Empty State */}
            {!state.error && !state.isLoading && state.query && state.results.length === 0 && !state.showSuggestions && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Search className="h-8 w-8 mb-3 opacity-50" />
                <p className="text-sm">No results found for "{state.query}"</p>
                <p className="text-xs mt-1">Try different keywords or check spelling</p>
              </div>
            )}

            {/* Suggestions */}
            {state.showSuggestions && state.suggestions.length > 0 && !state.results.length && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {state.query ? 'Suggestions' : 'Recent Searches'}
                </div>
                {state.suggestions.map((suggestion, index) => (
                  <button
                    key={`suggestion-${suggestion.type}-${suggestion.text}`}
                    data-index={index}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 rounded-lg',
                      'text-left transition-colors',
                      index === state.selectedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50 text-foreground'
                    )}
                    role="option"
                    aria-selected={index === state.selectedIndex}
                  >
                    <SuggestionIcon type={suggestion.type} />
                    <span className="flex-1 truncate">{suggestion.text}</span>
                    {suggestion.count !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {suggestion.count} result{suggestion.count !== 1 ? 's' : ''}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}

            {/* Search Results */}
            {state.results.length > 0 && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Results ({state.results.length})
                </div>
                {state.results.map((result, index) => (
                  <button
                    key={result.id}
                    data-index={index}
                    onClick={() => handleResultClick(result)}
                    className={cn(
                      'w-full flex flex-col gap-1 px-3 py-3 rounded-lg',
                      'text-left transition-colors',
                      index === state.selectedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50 text-foreground'
                    )}
                    role="option"
                    aria-selected={index === state.selectedIndex}
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span
                        className="font-medium truncate flex-1"
                        dangerouslySetInnerHTML={{
                          __html: result.highlightedTitle || result.title,
                        }}
                      />
                      <StatusBadge status={result.status} />
                    </div>
                    {(result.highlightedDescription || result.description) && (
                      <p
                        className="text-sm text-muted-foreground line-clamp-2 ml-6"
                        dangerouslySetInnerHTML={{
                          __html: result.highlightedDescription || truncateDescription(result.description),
                        }}
                      />
                    )}
                    {result.tags && result.tags.length > 0 && (
                      <div className="flex items-center gap-1 ml-6 mt-1">
                        <Tag className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {result.tags.slice(0, 3).join(', ')}
                          {result.tags.length > 3 && ` +${result.tags.length - 3}`}
                        </span>
                      </div>
                    )}
                  </button>
                ))}
              </>
            )}

            {/* Initial State - No query */}
            {!state.query && state.suggestions.length === 0 && !state.isLoading && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Search className="h-8 w-8 mb-3 opacity-50" />
                <p className="text-sm">Start typing to search tasks</p>
                <p className="text-xs mt-1">
                  Use <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono mx-1">↑</kbd>
                  <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono mx-1">↓</kbd> to navigate,
                  <kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono mx-1">enter</kbd> to select
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">↑</kbd>
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">↓</kbd>
                <span>navigate</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">enter</kbd>
                <span>select</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">tab</kbd>
                <span>autocomplete</span>
              </span>
            </div>
            <span>Full-text search powered by FTS5</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// Helper Components

function SuggestionIcon({ type }: { type: SearchSuggestion['type'] }) {
  switch (type) {
    case 'recent':
      return <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    case 'task':
      return <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    case 'tag':
      return <Tag className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    case 'status':
      return <AlertCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    default:
      return <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
  }
}

function StatusBadge({ status }: { status: string }) {
  const statusColors: Record<string, string> = {
    backlog: 'bg-muted text-muted-foreground',
    in_progress: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
    ai_review: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
    human_review: 'bg-purple-500/20 text-purple-600 dark:text-purple-400',
    done: 'bg-green-500/20 text-green-600 dark:text-green-400',
    archived: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
  };

  return (
    <span
      className={cn(
        'px-2 py-0.5 rounded-full text-[10px] font-medium uppercase',
        statusColors[status] || statusColors.backlog
      )}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

// Helper functions

function isSearchResult(item: SearchResult | SearchSuggestion): item is SearchResult {
  return 'id' in item && 'title' in item;
}

function truncateDescription(description: string, maxLength = 150): string {
  if (!description) return '';
  if (description.length <= maxLength) return description;
  return description.substring(0, maxLength).trim() + '...';
}

// CSS for highlight marks
const highlightStyles = `
  .search-highlight mark {
    background-color: rgba(var(--primary), 0.3);
    color: inherit;
    border-radius: 2px;
    padding: 0 2px;
  }
`;

// Inject highlight styles (only once)
if (typeof document !== 'undefined') {
  const styleId = 'global-search-highlights';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = highlightStyles;
    document.head.appendChild(style);
  }
}

export default GlobalSearch;
