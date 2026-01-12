import * as React from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Search, X, Clock, Tag, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SearchSuggestion, SearchSuggestionOptions } from '../../../shared/types';

export interface SearchInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'onSelect'> {
  /** Called when the input value changes */
  onChange?: (value: string) => void;
  /** Called when a suggestion is selected */
  onSuggestionSelect?: (suggestion: SearchSuggestion) => void;
  /** Called when the user presses Enter without selecting a suggestion */
  onSearch?: (query: string) => void;
  /** Project ID to filter suggestions */
  projectId?: string;
  /** Whether to show the search icon */
  showIcon?: boolean;
  /** Whether to show the clear button */
  showClearButton?: boolean;
  /** Whether to show autocomplete suggestions */
  showSuggestions?: boolean;
  /** Whether suggestions are currently loading */
  isLoading?: boolean;
  /** Debounce delay for suggestion fetching (ms) */
  debounceMs?: number;
  /** Minimum characters before fetching suggestions */
  minChars?: number;
  /** Maximum number of suggestions to show */
  maxSuggestions?: number;
  /** Custom suggestions to display (overrides API suggestions) */
  suggestions?: SearchSuggestion[];
  /** Error message to display */
  error?: string | null;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether input is in a compact form */
  compact?: boolean;
}

export interface SearchInputRef {
  /** Focus the input element */
  focus: () => void;
  /** Blur the input element */
  blur: () => void;
  /** Clear the input value */
  clear: () => void;
  /** Get the current input value */
  getValue: () => string;
  /** Set the input value */
  setValue: (value: string) => void;
}

/**
 * SearchInput - Search input component with autocomplete suggestions
 *
 * Features:
 * - Autocomplete suggestions from FTS5 search
 * - Debounced suggestion fetching
 * - Keyboard navigation (arrow keys, enter, escape)
 * - Clear button
 * - Loading state indicator
 * - Customizable size and appearance
 *
 * Usage:
 * ```tsx
 * <SearchInput
 *   placeholder="Search tasks..."
 *   onSearch={(query) => performSearch(query)}
 *   onSuggestionSelect={(suggestion) => handleSelect(suggestion)}
 * />
 * ```
 */
export const SearchInput = forwardRef<SearchInputRef, SearchInputProps>(
  (
    {
      className,
      onChange,
      onSuggestionSelect,
      onSearch,
      projectId,
      showIcon = true,
      showClearButton = true,
      showSuggestions: enableSuggestions = true,
      isLoading: externalLoading = false,
      debounceMs = 150,
      minChars = 2,
      maxSuggestions = 8,
      suggestions: externalSuggestions,
      error,
      size = 'md',
      compact = false,
      placeholder = 'Search...',
      disabled,
      ...props
    },
    ref
  ) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [value, setValue] = useState('');
    const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Use external suggestions if provided
    const displaySuggestions = externalSuggestions ?? suggestions;
    const loading = externalLoading || isLoading;

    // Expose imperative handle
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      clear: () => {
        setValue('');
        setSuggestions([]);
        setIsOpen(false);
        onChange?.('');
      },
      getValue: () => value,
      setValue: (newValue: string) => {
        setValue(newValue);
        onChange?.(newValue);
      },
    }));

    // Fetch suggestions from API
    const fetchSuggestions = useCallback(
      async (query: string) => {
        if (!enableSuggestions || query.length < minChars) {
          setSuggestions([]);
          return;
        }

        // Skip if using external suggestions
        if (externalSuggestions) return;

        setIsLoading(true);

        try {
          const options: SearchSuggestionOptions = {
            query,
            limit: maxSuggestions,
            includeRecent: true,
            ...(projectId && { projectId }),
          };

          const result = await window.electronAPI.getSuggestions(options);

          if (result.success && result.data) {
            setSuggestions(result.data.suggestions);
            setIsOpen(result.data.suggestions.length > 0);
            setSelectedIndex(-1);
          }
        } catch {
          // Silently fail - suggestions are not critical
          setSuggestions([]);
        } finally {
          setIsLoading(false);
        }
      },
      [enableSuggestions, externalSuggestions, minChars, maxSuggestions, projectId]
    );

    // Handle input change with debouncing
    const handleInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setValue(newValue);
        onChange?.(newValue);

        // Clear existing debounce
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
        }

        // Debounce suggestion fetching
        debounceRef.current = setTimeout(() => {
          if (newValue.trim()) {
            fetchSuggestions(newValue);
          } else {
            setSuggestions([]);
            setIsOpen(false);
          }
        }, debounceMs);
      },
      [onChange, debounceMs, fetchSuggestions]
    );

    // Handle keyboard navigation
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!isOpen || displaySuggestions.length === 0) {
          if (e.key === 'Enter' && value.trim()) {
            e.preventDefault();
            onSearch?.(value);
          }
          return;
        }

        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setSelectedIndex((prev) =>
              prev < displaySuggestions.length - 1 ? prev + 1 : 0
            );
            break;

          case 'ArrowUp':
            e.preventDefault();
            setSelectedIndex((prev) =>
              prev > 0 ? prev - 1 : displaySuggestions.length - 1
            );
            break;

          case 'Enter':
            e.preventDefault();
            if (selectedIndex >= 0 && selectedIndex < displaySuggestions.length) {
              const selected = displaySuggestions[selectedIndex];
              setValue(selected.text);
              onChange?.(selected.text);
              onSuggestionSelect?.(selected);
              setIsOpen(false);
              setSelectedIndex(-1);
            } else if (value.trim()) {
              onSearch?.(value);
              setIsOpen(false);
            }
            break;

          case 'Escape':
            e.preventDefault();
            setIsOpen(false);
            setSelectedIndex(-1);
            break;

          case 'Tab':
            // Autocomplete from first suggestion
            if (displaySuggestions.length > 0) {
              e.preventDefault();
              const firstSuggestion = displaySuggestions[0];
              setValue(firstSuggestion.text);
              onChange?.(firstSuggestion.text);
              setIsOpen(false);
            }
            break;
        }
      },
      [isOpen, displaySuggestions, selectedIndex, value, onChange, onSuggestionSelect, onSearch]
    );

    // Handle suggestion click
    const handleSuggestionClick = useCallback(
      (suggestion: SearchSuggestion, index: number) => {
        setValue(suggestion.text);
        onChange?.(suggestion.text);
        onSuggestionSelect?.(suggestion);
        setIsOpen(false);
        setSelectedIndex(-1);
        inputRef.current?.focus();
      },
      [onChange, onSuggestionSelect]
    );

    // Handle clear button click
    const handleClear = useCallback(() => {
      setValue('');
      setSuggestions([]);
      setIsOpen(false);
      setSelectedIndex(-1);
      onChange?.('');
      inputRef.current?.focus();
    }, [onChange]);

    // Handle focus
    const handleFocus = useCallback(() => {
      if (value.trim() && displaySuggestions.length > 0) {
        setIsOpen(true);
      }
    }, [value, displaySuggestions.length]);

    // Close suggestions when clicking outside
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
          setIsOpen(false);
          setSelectedIndex(-1);
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Scroll selected item into view
    useEffect(() => {
      if (isOpen && selectedIndex >= 0) {
        const selectedElement = containerRef.current?.querySelector(
          `[data-suggestion-index="${selectedIndex}"]`
        );
        selectedElement?.scrollIntoView({ block: 'nearest' });
      }
    }, [isOpen, selectedIndex]);

    // Size classes
    const sizeClasses = {
      sm: 'h-8 text-xs',
      md: 'h-10 text-sm',
      lg: 'h-12 text-base',
    };

    const iconSizeClasses = {
      sm: 'h-3.5 w-3.5',
      md: 'h-4 w-4',
      lg: 'h-5 w-5',
    };

    return (
      <div ref={containerRef} className={cn('relative', className)}>
        {/* Input Container */}
        <div
          className={cn(
            'flex items-center gap-2 w-full rounded-lg border border-border bg-card',
            compact ? 'px-2' : 'px-3',
            sizeClasses[size],
            'focus-within:ring-2 focus-within:ring-ring focus-within:border-primary',
            disabled && 'cursor-not-allowed opacity-50',
            error && 'border-destructive focus-within:border-destructive focus-within:ring-destructive/30',
            'transition-colors duration-200'
          )}
        >
          {/* Search Icon or Loading Spinner */}
          {showIcon && (
            loading ? (
              <Loader2
                className={cn(
                  'text-muted-foreground animate-spin flex-shrink-0',
                  iconSizeClasses[size]
                )}
              />
            ) : (
              <Search
                className={cn(
                  'text-muted-foreground flex-shrink-0',
                  iconSizeClasses[size]
                )}
              />
            )
          )}

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            placeholder={placeholder}
            disabled={disabled}
            className={cn(
              'flex-1 bg-transparent text-foreground',
              'placeholder:text-muted-foreground',
              'focus:outline-none',
              'disabled:cursor-not-allowed',
              sizeClasses[size]
            )}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Search"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-controls={isOpen ? 'search-suggestions' : undefined}
            aria-activedescendant={
              isOpen && selectedIndex >= 0
                ? `suggestion-${selectedIndex}`
                : undefined
            }
            {...props}
          />

          {/* Clear Button */}
          {showClearButton && value && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              className={cn(
                'p-1 rounded-md flex-shrink-0',
                'text-muted-foreground hover:text-foreground',
                'hover:bg-accent transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-ring'
              )}
              aria-label="Clear search"
            >
              <X className={iconSizeClasses[size]} />
            </button>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <p className="mt-1.5 text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {error}
          </p>
        )}

        {/* Suggestions Dropdown */}
        {isOpen && displaySuggestions.length > 0 && (
          <div
            id="search-suggestions"
            role="listbox"
            className={cn(
              'absolute z-50 w-full mt-1',
              'bg-popover border border-border rounded-lg shadow-lg',
              'max-h-64 overflow-y-auto',
              'animate-in fade-in-0 zoom-in-95 duration-100'
            )}
          >
            {displaySuggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.type}-${suggestion.text}-${index}`}
                id={`suggestion-${index}`}
                data-suggestion-index={index}
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => handleSuggestionClick(suggestion, index)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2',
                  'text-left transition-colors',
                  compact ? 'text-xs' : 'text-sm',
                  index === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted/50 text-foreground',
                  index === 0 && 'rounded-t-lg',
                  index === displaySuggestions.length - 1 && 'rounded-b-lg'
                )}
              >
                <SuggestionIcon type={suggestion.type} size={size} />
                <span className="flex-1 truncate">{suggestion.text}</span>
                {suggestion.count !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    {suggestion.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);

SearchInput.displayName = 'SearchInput';

// ========================
// Helper Components
// ========================

interface SuggestionIconProps {
  type: SearchSuggestion['type'];
  size?: 'sm' | 'md' | 'lg';
}

function SuggestionIcon({ type, size = 'md' }: SuggestionIconProps) {
  const iconSizeClasses = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
  };

  const iconClass = cn('text-muted-foreground flex-shrink-0', iconSizeClasses[size]);

  switch (type) {
    case 'recent':
      return <Clock className={iconClass} />;
    case 'task':
      return <FileText className={iconClass} />;
    case 'tag':
      return <Tag className={iconClass} />;
    case 'status':
      return <AlertCircle className={iconClass} />;
    default:
      return <Search className={iconClass} />;
  }
}

export default SearchInput;
