/**
 * UndoHistoryDropdown - Dropdown component showing the undo/redo stack
 *
 * Displays a list of operations that can be undone or redone:
 * - Shows operation descriptions with timestamps
 * - Allows clicking on an item to undo/redo to that point
 * - Uses Popover component for consistent styling
 */

import { useEffect, useState, useCallback } from 'react';
import { History, ChevronDown, Undo2, Redo2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import { cn } from '../../lib/utils';
import type { UndoStackState, UndoStackEntry } from '../../../shared/types';

// Detect if running on macOS for keyboard shortcut display
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '\u2318' : 'Ctrl';

interface UndoHistoryDropdownProps {
  /** Optional className for container styling */
  className?: string;
  /** Show undo or redo history */
  mode?: 'undo' | 'redo' | 'both';
  /** Maximum items to display */
  maxItems?: number;
}

/**
 * Format a timestamp as a relative time string
 */
function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

/**
 * Get an icon for an operation type
 */
function getOperationIcon(description: string): React.ReactNode {
  if (description.toLowerCase().includes('create')) {
    return <span className="text-green-500">+</span>;
  }
  if (description.toLowerCase().includes('delete')) {
    return <span className="text-red-500">-</span>;
  }
  if (description.toLowerCase().includes('status')) {
    return <span className="text-blue-500">~</span>;
  }
  return <span className="text-muted-foreground">~</span>;
}

export function UndoHistoryDropdown({
  className = '',
  mode = 'both',
  maxItems = 10,
}: UndoHistoryDropdownProps) {
  const [state, setState] = useState<UndoStackState>({
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    isProcessing: false,
  });
  const [isEnabled, setIsEnabled] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  // Load initial state and check if feature is enabled
  useEffect(() => {
    const loadState = async () => {
      try {
        // Check if undo feature is enabled
        const enabledResult = await window.api.isEnabled();
        if (enabledResult.success && enabledResult.data !== undefined) {
          setIsEnabled(enabledResult.data);
        }

        // Get current undo/redo state
        const historyResult = await window.api.getHistory();
        if (historyResult.success && historyResult.data) {
          setState(historyResult.data);
        }
      } catch (error) {
        // Feature might not be available, disable it
        setIsEnabled(false);
      }
    };

    loadState();
  }, []);

  // Listen for state changes from main process
  useEffect(() => {
    if (!isEnabled) return;

    const unsubscribe = window.api.onStateChanged((newState: UndoStackState) => {
      setState(newState);
    });

    return () => {
      unsubscribe();
    };
  }, [isEnabled]);

  // Handle undo action
  const handleUndo = useCallback(async () => {
    if (!state.canUndo || state.isProcessing) return;

    try {
      setState(prev => ({ ...prev, isProcessing: true }));
      await window.api.undo();
    } catch {
      // Error handling - state will be updated by listener
    }
  }, [state.canUndo, state.isProcessing]);

  // Handle redo action
  const handleRedo = useCallback(async () => {
    if (!state.canRedo || state.isProcessing) return;

    try {
      setState(prev => ({ ...prev, isProcessing: true }));
      await window.api.redo();
    } catch {
      // Error handling - state will be updated by listener
    }
  }, [state.canRedo, state.isProcessing]);

  // Handle clicking on a specific history item to undo/redo to that point
  const handleUndoToItem = useCallback(async (index: number) => {
    if (state.isProcessing) return;

    setState(prev => ({ ...prev, isProcessing: true }));
    try {
      // Perform undo operations up to and including the selected item
      for (let i = 0; i <= index; i++) {
        await window.api.undo();
      }
      setIsOpen(false);
    } catch {
      // Error handling - state will be updated by listener
    }
  }, [state.isProcessing]);

  const handleRedoToItem = useCallback(async (index: number) => {
    if (state.isProcessing) return;

    setState(prev => ({ ...prev, isProcessing: true }));
    try {
      // Perform redo operations up to and including the selected item
      for (let i = 0; i <= index; i++) {
        await window.api.redo();
      }
      setIsOpen(false);
    } catch {
      // Error handling - state will be updated by listener
    }
  }, [state.isProcessing]);

  // Don't render if feature is disabled
  if (!isEnabled) {
    return null;
  }

  const undoItems = state.undoStack.slice(0, maxItems);
  const redoItems = state.redoStack.slice(0, maxItems);
  const hasItems = (mode === 'undo' && undoItems.length > 0) ||
                   (mode === 'redo' && redoItems.length > 0) ||
                   (mode === 'both' && (undoItems.length > 0 || redoItems.length > 0));

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 gap-1', className)}
          disabled={!hasItems || state.isProcessing}
          aria-label="View undo/redo history"
        >
          <History className="h-4 w-4" />
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        sideOffset={4}
      >
        <div className="flex flex-col max-h-96 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-medium">History</span>
            <span className="text-xs text-muted-foreground">
              {modKey}+Z / {modKey}+Shift+Z
            </span>
          </div>

          {/* Undo Section */}
          {(mode === 'undo' || mode === 'both') && undoItems.length > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50">
                <Undo2 className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">
                  Undo ({undoItems.length})
                </span>
              </div>
              <div className="flex flex-col overflow-y-auto max-h-40">
                {undoItems.map((entry: UndoStackEntry, index: number) => (
                  <HistoryItem
                    key={entry.id}
                    entry={entry}
                    onClick={() => handleUndoToItem(index)}
                    disabled={state.isProcessing}
                    isFirst={index === 0}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Redo Section */}
          {(mode === 'redo' || mode === 'both') && redoItems.length > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-t">
                <Redo2 className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">
                  Redo ({redoItems.length})
                </span>
              </div>
              <div className="flex flex-col overflow-y-auto max-h-40">
                {redoItems.map((entry: UndoStackEntry, index: number) => (
                  <HistoryItem
                    key={entry.id}
                    entry={entry}
                    onClick={() => handleRedoToItem(index)}
                    disabled={state.isProcessing}
                    isFirst={index === 0}
                    isRedo
                  />
                ))}
              </div>
            </div>
          )}

          {/* Empty State */}
          {!hasItems && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <History className="h-8 w-8 text-muted-foreground/50 mb-2" />
              <span className="text-sm text-muted-foreground">No history available</span>
              <span className="text-xs text-muted-foreground/70 mt-1">
                Make changes to see them here
              </span>
            </div>
          )}

          {/* Quick Actions */}
          {hasItems && (
            <div className="flex items-center gap-2 px-3 py-2 border-t bg-muted/30">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={handleUndo}
                disabled={!state.canUndo || state.isProcessing}
              >
                <Undo2 className="h-3 w-3 mr-1" />
                Undo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={handleRedo}
                disabled={!state.canRedo || state.isProcessing}
              >
                <Redo2 className="h-3 w-3 mr-1" />
                Redo
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Individual history item component
 */
interface HistoryItemProps {
  entry: UndoStackEntry;
  onClick: () => void;
  disabled: boolean;
  isFirst: boolean;
  isRedo?: boolean;
}

function HistoryItem({ entry, onClick, disabled, isFirst, isRedo = false }: HistoryItemProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/80 transition-colors',
        'focus:outline-none focus:bg-muted',
        isFirst && 'bg-muted/40',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="flex-shrink-0 w-4 text-center">
        {getOperationIcon(entry.description)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">
          {entry.description}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatRelativeTime(entry.timestamp)}
        </div>
      </div>
      {isFirst && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          {isRedo ? 'Next' : 'Last'}
        </span>
      )}
    </button>
  );
}

export default UndoHistoryDropdown;
