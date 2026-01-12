import * as React from 'react';
import { memo, useCallback, useEffect, useRef } from 'react';
import { FileText, Search, Tag, Clock, Folder } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SearchResult, TaskStatus } from '../../../shared/types';

interface SearchResultsProps {
  /** Array of search results to display */
  results: SearchResult[];
  /** Currently selected index for keyboard navigation */
  selectedIndex: number;
  /** Callback when selection changes */
  onSelectedIndexChange?: (index: number) => void;
  /** Callback when a result is selected/clicked */
  onResultSelect?: (result: SearchResult) => void;
  /** Whether to show the results header with count */
  showHeader?: boolean;
  /** Custom header text (default: "Results") */
  headerText?: string;
  /** Whether results are currently loading */
  isLoading?: boolean;
  /** Optional class name for the container */
  className?: string;
  /** Maximum height before scrolling (default: auto) */
  maxHeight?: string | number;
  /** Whether to compact the display (smaller padding/text) */
  compact?: boolean;
  /** Whether to show project name in results */
  showProject?: boolean;
  /** Whether to show timestamps in results */
  showTimestamp?: boolean;
}

/**
 * SearchResults - Displays a list of search results with highlighting
 *
 * Features:
 * - Result highlighting with <mark> tags from FTS5
 * - Keyboard navigation support (controlled via selectedIndex)
 * - Status badges with color coding
 * - Tag display
 * - Responsive layout
 * - Accessibility support
 *
 * The component is controlled - parent manages selectedIndex and selection.
 */
export const SearchResults = memo(function SearchResults({
  results,
  selectedIndex,
  onSelectedIndexChange,
  onResultSelect,
  showHeader = true,
  headerText = 'Results',
  isLoading = false,
  className,
  maxHeight,
  compact = false,
  showProject = false,
  showTimestamp = false,
}: SearchResultsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && results.length > 0) {
      const selectedElement = listRef.current.querySelector(
        `[data-result-index="${selectedIndex}"]`
      );
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, results.length]);

  // Handle result click
  const handleResultClick = useCallback(
    (result: SearchResult, index: number) => {
      onSelectedIndexChange?.(index);
      onResultSelect?.(result);
    },
    [onSelectedIndexChange, onResultSelect]
  );

  // Handle mouse enter for hover selection
  const handleMouseEnter = useCallback(
    (index: number) => {
      onSelectedIndexChange?.(index);
    },
    [onSelectedIndexChange]
  );

  if (results.length === 0) {
    return null;
  }

  return (
    <div
      className={cn('flex flex-col', className)}
      style={{ maxHeight: maxHeight || 'auto' }}
    >
      {/* Header */}
      {showHeader && (
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Search className="h-3 w-3" />
          <span>
            {headerText} ({results.length})
          </span>
          {isLoading && (
            <span className="animate-pulse text-primary">searching...</span>
          )}
        </div>
      )}

      {/* Results List */}
      <div
        ref={listRef}
        className="overflow-y-auto"
        role="listbox"
        aria-label="Search results"
      >
        {results.map((result, index) => (
          <SearchResultItem
            key={result.id}
            result={result}
            index={index}
            isSelected={index === selectedIndex}
            onClick={() => handleResultClick(result, index)}
            onMouseEnter={() => handleMouseEnter(index)}
            compact={compact}
            showProject={showProject}
            showTimestamp={showTimestamp}
          />
        ))}
      </div>
    </div>
  );
});

// ========================
// SearchResultItem Component
// ========================

interface SearchResultItemProps {
  result: SearchResult;
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  compact?: boolean;
  showProject?: boolean;
  showTimestamp?: boolean;
}

const SearchResultItem = memo(function SearchResultItem({
  result,
  index,
  isSelected,
  onClick,
  onMouseEnter,
  compact = false,
  showProject = false,
  showTimestamp = false,
}: SearchResultItemProps) {
  return (
    <button
      data-result-index={index}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full flex flex-col gap-1 rounded-lg text-left transition-colors',
        compact ? 'px-2 py-2' : 'px-3 py-3',
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-muted/50 text-foreground'
      )}
      role="option"
      aria-selected={isSelected}
    >
      {/* Title Row */}
      <div className="flex items-center gap-2">
        <FileText
          className={cn(
            'flex-shrink-0 text-muted-foreground',
            compact ? 'h-3.5 w-3.5' : 'h-4 w-4'
          )}
        />
        <HighlightedText
          text={result.highlightedTitle || result.title}
          className={cn('font-medium truncate flex-1', compact && 'text-sm')}
        />
        <StatusBadge status={result.status} compact={compact} />
      </div>

      {/* Description Row */}
      {(result.highlightedDescription || result.description) && (
        <HighlightedText
          text={
            result.highlightedDescription ||
            truncateText(result.description, 150)
          }
          className={cn(
            'text-muted-foreground line-clamp-2',
            compact ? 'ml-5 text-xs' : 'ml-6 text-sm'
          )}
        />
      )}

      {/* Metadata Row */}
      <div
        className={cn(
          'flex items-center flex-wrap gap-2 text-muted-foreground',
          compact ? 'ml-5 mt-0.5' : 'ml-6 mt-1'
        )}
      >
        {/* Tags */}
        {result.tags && result.tags.length > 0 && (
          <div className="flex items-center gap-1">
            <Tag className={cn('flex-shrink-0', compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
            <span className={cn(compact ? 'text-[10px]' : 'text-xs')}>
              {result.tags.slice(0, 3).join(', ')}
              {result.tags.length > 3 && ` +${result.tags.length - 3}`}
            </span>
          </div>
        )}

        {/* Project */}
        {showProject && result.projectId && (
          <div className="flex items-center gap-1">
            <Folder className={cn('flex-shrink-0', compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
            <span className={cn(compact ? 'text-[10px]' : 'text-xs')}>
              {result.projectId}
            </span>
          </div>
        )}

        {/* Timestamp */}
        {showTimestamp && result.updatedAt && (
          <div className="flex items-center gap-1">
            <Clock className={cn('flex-shrink-0', compact ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
            <span className={cn(compact ? 'text-[10px]' : 'text-xs')}>
              {formatRelativeTime(result.updatedAt)}
            </span>
          </div>
        )}

        {/* Matched fields indicator */}
        {result.matchedFields && result.matchedFields.length > 0 && (
          <span
            className={cn(
              'text-muted-foreground/60 italic',
              compact ? 'text-[10px]' : 'text-xs'
            )}
          >
            matched in: {result.matchedFields.join(', ')}
          </span>
        )}
      </div>
    </button>
  );
});

// ========================
// HighlightedText Component
// ========================

interface HighlightedTextProps {
  text: string;
  className?: string;
}

/**
 * Renders text with <mark> tags as highlighted spans
 * Safely handles HTML by only allowing mark tags
 */
const HighlightedText = memo(function HighlightedText({
  text,
  className,
}: HighlightedTextProps) {
  // If text contains mark tags, render with dangerouslySetInnerHTML
  // Otherwise just render as plain text
  if (text.includes('<mark>')) {
    return (
      <span
        className={cn('search-highlight', className)}
        dangerouslySetInnerHTML={{ __html: sanitizeHighlightHtml(text) }}
      />
    );
  }

  return <span className={className}>{text}</span>;
});

// ========================
// StatusBadge Component
// ========================

interface StatusBadgeProps {
  status: TaskStatus | string;
  compact?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  backlog: 'bg-muted text-muted-foreground',
  in_progress: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
  ai_review: 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
  human_review: 'bg-purple-500/20 text-purple-600 dark:text-purple-400',
  done: 'bg-green-500/20 text-green-600 dark:text-green-400',
  archived: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
};

const StatusBadge = memo(function StatusBadge({
  status,
  compact = false,
}: StatusBadgeProps) {
  const colorClass = STATUS_COLORS[status] || STATUS_COLORS.backlog;
  const displayText = status.replace(/_/g, ' ');

  return (
    <span
      className={cn(
        'rounded-full font-medium uppercase flex-shrink-0',
        compact
          ? 'px-1.5 py-0.5 text-[8px]'
          : 'px-2 py-0.5 text-[10px]',
        colorClass
      )}
    >
      {displayText}
    </span>
  );
});

// ========================
// Helper Functions
// ========================

/**
 * Sanitize HTML to only allow <mark> tags for security
 */
function sanitizeHighlightHtml(html: string): string {
  // Replace all tags except mark with escaped versions
  return html
    .replace(/<(?!\/?mark>)/g, '&lt;')
    .replace(/(?<!<\/?mark)>/g, '&gt;');
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

/**
 * Format a date as relative time
 */
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ========================
// CSS Injection for Highlights
// ========================

// Inject highlight styles (only once)
if (typeof document !== 'undefined') {
  const styleId = 'search-results-highlights';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .search-highlight mark {
        background-color: hsl(var(--primary) / 0.3);
        color: inherit;
        border-radius: 2px;
        padding: 0 2px;
      }
      .dark .search-highlight mark {
        background-color: hsl(var(--primary) / 0.4);
      }
    `;
    document.head.appendChild(style);
  }
}

export default SearchResults;
