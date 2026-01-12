/**
 * UndoRedoButtons - Toolbar component for undo/redo operations
 *
 * Provides visual undo/redo buttons with:
 * - Disabled state when no operations available
 * - Tooltips showing operation descriptions
 * - Keyboard shortcut hints (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z)
 */

import { useEffect, useState, useCallback } from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import type { UndoStackState } from '../../../shared/types';

// Detect if running on macOS for keyboard shortcut display
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '\u2318' : 'Ctrl';

interface UndoRedoButtonsProps {
  /** Optional className for container styling */
  className?: string;
  /** Compact mode for smaller buttons (icon size only) */
  compact?: boolean;
}

export function UndoRedoButtons({ className = '', compact = true }: UndoRedoButtonsProps) {
  const [state, setState] = useState<UndoStackState>({
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
    isProcessing: false,
  });
  const [isEnabled, setIsEnabled] = useState(true);

  // Load initial state and check if feature is enabled
  useEffect(() => {
    const loadState = async () => {
      try {
        // Check if undo feature is enabled
        const enabledResult = await window.electronAPI.isEnabled();
        if (enabledResult.success && enabledResult.data !== undefined) {
          setIsEnabled(enabledResult.data);
        }

        // Get current undo/redo state
        const historyResult = await window.electronAPI.getHistory();
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

    const unsubscribe = window.electronAPI.onStateChanged((newState: UndoStackState) => {
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
      const result = await window.electronAPI.undo();
      if (!result.success) {
        // Could show toast notification here
      }
    } finally {
      // State will be updated by the onStateChanged listener
    }
  }, [state.canUndo, state.isProcessing]);

  // Handle redo action
  const handleRedo = useCallback(async () => {
    if (!state.canRedo || state.isProcessing) return;

    try {
      setState(prev => ({ ...prev, isProcessing: true }));
      const result = await window.electronAPI.redo();
      if (!result.success) {
        // Could show toast notification here
      }
    } finally {
      // State will be updated by the onStateChanged listener
    }
  }, [state.canRedo, state.isProcessing]);

  // Don't render if feature is disabled
  if (!isEnabled) {
    return null;
  }

  const undoTooltip = state.canUndo && state.lastUndoDescription
    ? `Undo: ${state.lastUndoDescription}`
    : 'Undo';

  const redoTooltip = state.canRedo && state.lastRedoDescription
    ? `Redo: ${state.lastRedoDescription}`
    : 'Redo';

  return (
    <TooltipProvider delayDuration={200}>
      <div className={`flex items-center gap-1 ${className}`}>
        {/* Undo Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={compact ? 'icon' : 'sm'}
              onClick={handleUndo}
              disabled={!state.canUndo || state.isProcessing}
              aria-label={undoTooltip}
              className={compact ? 'h-8 w-8' : ''}
            >
              <Undo2 className={compact ? 'h-4 w-4' : 'h-4 w-4 mr-1'} />
              {!compact && <span>Undo</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <div className="flex flex-col gap-0.5">
              <span>{undoTooltip}</span>
              <span className="text-muted-foreground text-[10px]">
                {modKey}+Z
              </span>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Redo Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={compact ? 'icon' : 'sm'}
              onClick={handleRedo}
              disabled={!state.canRedo || state.isProcessing}
              aria-label={redoTooltip}
              className={compact ? 'h-8 w-8' : ''}
            >
              <Redo2 className={compact ? 'h-4 w-4' : 'h-4 w-4 mr-1'} />
              {!compact && <span>Redo</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            <div className="flex flex-col gap-0.5">
              <span>{redoTooltip}</span>
              <span className="text-muted-foreground text-[10px]">
                {modKey}+Shift+Z
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

export default UndoRedoButtons;
