import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  History,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ArrowRight,
  Move,
  ChevronDown,
  ChevronRight,
  Filter,
  Clock,
  User,
  Bot,
  Settings,
  CheckCircle2
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import type { Task } from '../../../shared/types';
import type { TaskHistoryEntry, HistoryAction, ChangedBy, HistoryValueSnapshot } from '../../../shared/types/history';

interface TaskHistoryProps {
  task: Task;
}

// Action labels and styling
const ACTION_CONFIG: Record<HistoryAction, { icon: typeof Plus; label: string; color: string }> = {
  created: {
    icon: Plus,
    label: 'Created',
    color: 'text-success bg-success/10 border-success/30'
  },
  updated: {
    icon: Pencil,
    label: 'Updated',
    color: 'text-info bg-info/10 border-info/30'
  },
  deleted: {
    icon: Trash2,
    label: 'Deleted',
    color: 'text-destructive bg-destructive/10 border-destructive/30'
  },
  status_changed: {
    icon: ArrowRight,
    label: 'Status Changed',
    color: 'text-amber-500 bg-amber-500/10 border-amber-500/30'
  },
  moved: {
    icon: Move,
    label: 'Moved',
    color: 'text-purple-500 bg-purple-500/10 border-purple-500/30'
  }
};

// Changed by icons
const CHANGED_BY_ICONS: Record<ChangedBy, typeof User> = {
  user: User,
  system: Settings,
  agent: Bot
};

/**
 * TaskHistory component displays a timeline view of all changes to a task
 * with filtering capabilities by action type and changed by entity
 */
export function TaskHistory({ task }: TaskHistoryProps) {
  const { t } = useTranslation('tasks');
  const [historyEntries, setHistoryEntries] = useState<TaskHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());

  // Filter state
  const [selectedActions, setSelectedActions] = useState<Set<HistoryAction>>(
    new Set(['created', 'updated', 'deleted', 'status_changed', 'moved'])
  );
  const [selectedChangedBy, setSelectedChangedBy] = useState<Set<ChangedBy>>(
    new Set(['user', 'system', 'agent'])
  );

  // Load history entries
  useEffect(() => {
    let isMounted = true;

    const loadHistory = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Check if history feature is enabled
        const enabledResult = await window.electronAPI.isEnabled();
        if (!enabledResult.success || !enabledResult.data) {
          if (isMounted) {
            setHistoryEntries([]);
            setError(t('history.featureDisabled', 'History feature is not enabled'));
          }
          return;
        }

        // Load history for this task
        const result = await window.electronAPI.getTaskHistory(task.id);
        if (isMounted) {
          if (result.success && result.data) {
            // result.data is HistoryQueryResult with entries array
            setHistoryEntries(result.data.entries || []);
          } else {
            setError(result.error || t('history.loadError', 'Failed to load history'));
          }
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : t('history.unknownError', 'Unknown error'));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadHistory();

    return () => {
      isMounted = false;
    };
  }, [task.id, t]);

  // Filter entries based on selected filters
  const filteredEntries = useMemo(() => {
    return historyEntries.filter(entry =>
      selectedActions.has(entry.action) &&
      selectedChangedBy.has(entry.changedBy)
    );
  }, [historyEntries, selectedActions, selectedChangedBy]);

  // Toggle action filter
  const toggleActionFilter = (action: HistoryAction) => {
    setSelectedActions(prev => {
      const next = new Set(prev);
      if (next.has(action)) {
        // Don't allow deselecting all
        if (next.size > 1) {
          next.delete(action);
        }
      } else {
        next.add(action);
      }
      return next;
    });
  };

  // Toggle changed by filter
  const toggleChangedByFilter = (changedBy: ChangedBy) => {
    setSelectedChangedBy(prev => {
      const next = new Set(prev);
      if (next.has(changedBy)) {
        // Don't allow deselecting all
        if (next.size > 1) {
          next.delete(changedBy);
        }
      } else {
        next.add(changedBy);
      }
      return next;
    });
  };

  // Toggle entry expansion
  const toggleEntry = (entryId: number) => {
    setExpandedEntries(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  // Format timestamp for display
  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return {
        date: date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        }),
        time: date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit'
        })
      };
    } catch {
      return { date: '', time: '' };
    }
  };

  // Parse JSON value safely
  const parseValue = (value: string | undefined): HistoryValueSnapshot | null => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  // Render loading state
  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center py-8 text-muted-foreground">
        <History className="mx-auto mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  // Render empty state
  if (historyEntries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center py-8 text-muted-foreground">
        <History className="mx-auto mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">{t('history.noHistory', 'No history yet')}</p>
        <p className="text-xs mt-1">{t('history.noHistoryHint', 'Changes will appear here as you modify the task')}</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
      <div className="p-4 space-y-4">
        {/* Filter controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Action type filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1">
                <Filter className="h-3.5 w-3.5" />
                <span>{t('history.filterByAction', 'Action')}</span>
                <Badge variant="secondary" className="ml-1 text-[10px] px-1.5">
                  {selectedActions.size}
                </Badge>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{t('history.actionTypes', 'Action Types')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.keys(ACTION_CONFIG) as HistoryAction[]).map(action => {
                const config = ACTION_CONFIG[action];
                const Icon = config.icon;
                return (
                  <DropdownMenuCheckboxItem
                    key={action}
                    checked={selectedActions.has(action)}
                    onCheckedChange={() => toggleActionFilter(action)}
                  >
                    <Icon className="h-3.5 w-3.5 mr-2" />
                    {config.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Changed by filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1">
                <User className="h-3.5 w-3.5" />
                <span>{t('history.filterByChangedBy', 'Changed By')}</span>
                <Badge variant="secondary" className="ml-1 text-[10px] px-1.5">
                  {selectedChangedBy.size}
                </Badge>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{t('history.changedByTypes', 'Changed By')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.keys(CHANGED_BY_ICONS) as ChangedBy[]).map(changedBy => {
                const Icon = CHANGED_BY_ICONS[changedBy];
                return (
                  <DropdownMenuCheckboxItem
                    key={changedBy}
                    checked={selectedChangedBy.has(changedBy)}
                    onCheckedChange={() => toggleChangedByFilter(changedBy)}
                  >
                    <Icon className="h-3.5 w-3.5 mr-2" />
                    {changedBy.charAt(0).toUpperCase() + changedBy.slice(1)}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Results count */}
          <span className="text-xs text-muted-foreground ml-auto">
            {filteredEntries.length} of {historyEntries.length} {t('history.entries', 'entries')}
          </span>
        </div>

        {/* Timeline */}
        <div className="relative space-y-2">
          {/* Timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />

          {/* Filtered entries */}
          {filteredEntries.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8 ml-8">
              {t('history.noMatchingEntries', 'No entries match the current filters')}
            </div>
          ) : (
            filteredEntries.map(entry => (
              <HistoryEntryItem
                key={entry.id}
                entry={entry}
                isExpanded={expandedEntries.has(entry.id)}
                onToggle={() => toggleEntry(entry.id)}
                formatTimestamp={formatTimestamp}
                parseValue={parseValue}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Individual history entry component
interface HistoryEntryItemProps {
  entry: TaskHistoryEntry;
  isExpanded: boolean;
  onToggle: () => void;
  formatTimestamp: (timestamp: string) => { date: string; time: string };
  parseValue: (value: string | undefined) => HistoryValueSnapshot | null;
}

function HistoryEntryItem({ entry, isExpanded, onToggle, formatTimestamp, parseValue }: HistoryEntryItemProps) {
  const config = ACTION_CONFIG[entry.action];
  const Icon = config.icon;
  const ChangedByIcon = CHANGED_BY_ICONS[entry.changedBy];
  const { date, time } = formatTimestamp(entry.timestamp);

  const oldValue = parseValue(entry.oldValue);
  const newValue = parseValue(entry.newValue);
  const hasDiff = (oldValue && newValue) || entry.fieldName;

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div className="relative pl-8">
        {/* Timeline dot */}
        <div className={cn(
          'absolute left-2.5 w-3 h-3 rounded-full border-2 bg-background -translate-x-1/2 mt-3',
          config.color.split(' ').find(c => c.startsWith('border-'))
        )} />

        {/* Entry card */}
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              'w-full flex items-start gap-3 p-3 rounded-lg border transition-colors text-left',
              'hover:bg-secondary/50',
              config.color
            )}
          >
            {/* Icon */}
            <div className="shrink-0 mt-0.5">
              <Icon className="h-4 w-4" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{config.label}</span>
                {entry.fieldName && (
                  <Badge variant="outline" className="text-[10px] px-1.5">
                    {entry.fieldName}
                  </Badge>
                )}
              </div>

              {/* Timestamp and changed by */}
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>{date} at {time}</span>
                <span className="text-muted-foreground/50">|</span>
                <ChangedByIcon className="h-3 w-3" />
                <span className="capitalize">{entry.changedBy}</span>
              </div>
            </div>

            {/* Expand indicator */}
            {hasDiff && (
              <div className="shrink-0 text-muted-foreground">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </div>
            )}
          </button>
        </CollapsibleTrigger>

        {/* Expanded diff content */}
        {hasDiff && (
          <CollapsibleContent>
            <div className="mt-1 ml-7 p-3 bg-secondary/30 rounded-md border border-border/50 space-y-2">
              {entry.action === 'created' && newValue && (
                <DiffSection title="Created with" value={newValue} type="added" />
              )}
              {entry.action === 'deleted' && oldValue && (
                <DiffSection title="Deleted values" value={oldValue} type="removed" />
              )}
              {(entry.action === 'updated' || entry.action === 'status_changed') && (
                <>
                  {oldValue && <DiffSection title="Previous" value={oldValue} type="removed" />}
                  {newValue && <DiffSection title="New" value={newValue} type="added" />}
                </>
              )}
              {entry.action === 'moved' && (
                <>
                  {oldValue && <DiffSection title="From" value={oldValue} type="removed" />}
                  {newValue && <DiffSection title="To" value={newValue} type="added" />}
                </>
              )}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

// Diff section component
interface DiffSectionProps {
  title: string;
  value: HistoryValueSnapshot;
  type: 'added' | 'removed';
}

function DiffSection({ title, value, type }: DiffSectionProps) {
  const bgColor = type === 'added' ? 'bg-success/10' : 'bg-destructive/10';
  const textColor = type === 'added' ? 'text-success' : 'text-destructive';
  const borderColor = type === 'added' ? 'border-success/20' : 'border-destructive/20';

  // Filter out empty/undefined values
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== '');

  if (entries.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {type === 'added' ? (
          <CheckCircle2 className={cn('h-3 w-3', textColor)} />
        ) : (
          <Trash2 className={cn('h-3 w-3', textColor)} />
        )}
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      <div className={cn('rounded-md border p-2 space-y-1', bgColor, borderColor)}>
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-2 text-xs">
            <span className="font-medium text-muted-foreground shrink-0 capitalize">
              {key}:
            </span>
            <span className={cn('break-words', textColor)}>
              {String(val)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
