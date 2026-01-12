import { memo, useMemo } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  ArrowRight,
  Move,
  ChevronDown,
  ChevronRight,
  Clock,
  User,
  Bot,
  Settings,
  CheckCircle2,
  Minus
} from 'lucide-react';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../ui/collapsible';
import { cn } from '../../lib/utils';
import type { TaskHistoryEntry, HistoryAction, ChangedBy, HistoryValueSnapshot } from '../../../shared/types/history';

/**
 * Configuration for action types with icons, labels, and styling
 */
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

/**
 * Icons for the "changed by" entity types
 */
const CHANGED_BY_ICONS: Record<ChangedBy, typeof User> = {
  user: User,
  system: Settings,
  agent: Bot
};

/**
 * Labels for the "changed by" entity types
 */
const CHANGED_BY_LABELS: Record<ChangedBy, string> = {
  user: 'User',
  system: 'System',
  agent: 'AI Agent'
};

/**
 * Props for the HistoryEntry component
 */
export interface HistoryEntryProps {
  /** The history entry data */
  entry: TaskHistoryEntry;
  /** Whether the entry is expanded to show diff details */
  isExpanded: boolean;
  /** Callback when the entry is toggled */
  onToggle: () => void;
  /** Optional custom className */
  className?: string;
  /** Whether to show the timeline dot */
  showTimelineDot?: boolean;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: string): { date: string; time: string; relative: string } {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    let relative = '';
    if (diffMins < 1) {
      relative = 'Just now';
    } else if (diffMins < 60) {
      relative = `${diffMins}m ago`;
    } else if (diffHours < 24) {
      relative = `${diffHours}h ago`;
    } else if (diffDays < 7) {
      relative = `${diffDays}d ago`;
    } else {
      relative = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    return {
      date: date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
      }),
      time: date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      }),
      relative
    };
  } catch {
    return { date: '', time: '', relative: '' };
  }
}

/**
 * Parse JSON value safely
 */
function parseValue(value: string | undefined): HistoryValueSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * HistoryEntry component displays a single history entry with collapsible diff view.
 * Used in TaskHistory to show individual changes in the timeline.
 */
export const HistoryEntry = memo(function HistoryEntry({
  entry,
  isExpanded,
  onToggle,
  className,
  showTimelineDot = true
}: HistoryEntryProps) {
  const config = ACTION_CONFIG[entry.action];
  const Icon = config.icon;
  const ChangedByIcon = CHANGED_BY_ICONS[entry.changedBy];
  const { date, time, relative } = useMemo(() => formatTimestamp(entry.timestamp), [entry.timestamp]);

  const oldValue = useMemo(() => parseValue(entry.oldValue), [entry.oldValue]);
  const newValue = useMemo(() => parseValue(entry.newValue), [entry.newValue]);
  const hasDiff = (oldValue && newValue) || entry.fieldName || oldValue || newValue;

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div className={cn('relative', showTimelineDot && 'pl-8', className)}>
        {/* Timeline dot */}
        {showTimelineDot && (
          <div className={cn(
            'absolute left-2.5 w-3 h-3 rounded-full border-2 bg-background -translate-x-1/2 mt-3',
            config.color.split(' ').find(c => c.startsWith('border-'))
          )} />
        )}

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
                <span title={`${date} at ${time}`}>{relative}</span>
                <span className="text-muted-foreground/50">|</span>
                <ChangedByIcon className="h-3 w-3" />
                <span>{CHANGED_BY_LABELS[entry.changedBy]}</span>
                {entry.sessionId && (
                  <>
                    <span className="text-muted-foreground/50">|</span>
                    <span className="text-muted-foreground/70 text-[10px]" title={`Session: ${entry.sessionId}`}>
                      {entry.sessionId.slice(0, 8)}
                    </span>
                  </>
                )}
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
            <div className="mt-1 ml-7 p-3 bg-secondary/30 rounded-md border border-border/50 space-y-3">
              {entry.action === 'created' && newValue && (
                <DiffSection title="Created with" value={newValue} type="added" />
              )}
              {entry.action === 'deleted' && oldValue && (
                <DiffSection title="Deleted values" value={oldValue} type="removed" />
              )}
              {(entry.action === 'updated' || entry.action === 'status_changed') && (
                <>
                  {oldValue && newValue ? (
                    <FieldDiff oldValue={oldValue} newValue={newValue} fieldName={entry.fieldName} />
                  ) : (
                    <>
                      {oldValue && <DiffSection title="Previous" value={oldValue} type="removed" />}
                      {newValue && <DiffSection title="New" value={newValue} type="added" />}
                    </>
                  )}
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
});

/**
 * Props for the DiffSection component
 */
interface DiffSectionProps {
  title: string;
  value: HistoryValueSnapshot;
  type: 'added' | 'removed';
}

/**
 * DiffSection displays a set of field values with appropriate styling
 * for additions (green) or removals (red).
 */
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
          <Plus className={cn('h-3 w-3', textColor)} />
        ) : (
          <Minus className={cn('h-3 w-3', textColor)} />
        )}
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      <div className={cn('rounded-md border p-2 space-y-1', bgColor, borderColor)}>
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-2 text-xs">
            <span className="font-medium text-muted-foreground shrink-0 capitalize min-w-[80px]">
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

/**
 * Props for the FieldDiff component
 */
interface FieldDiffProps {
  oldValue: HistoryValueSnapshot;
  newValue: HistoryValueSnapshot;
  fieldName?: string;
}

/**
 * FieldDiff displays a side-by-side or inline comparison of changed fields.
 * Highlights which specific fields changed between old and new values.
 */
function FieldDiff({ oldValue, newValue, fieldName }: FieldDiffProps) {
  // Get all unique keys from both objects
  const allKeys = useMemo(() => {
    const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
    // If a specific field is mentioned, prioritize it
    if (fieldName && keys.has(fieldName)) {
      return [fieldName, ...Array.from(keys).filter(k => k !== fieldName)];
    }
    return Array.from(keys);
  }, [oldValue, newValue, fieldName]);

  // Find changed fields
  const changedFields = useMemo(() => {
    return allKeys.filter(key => {
      const oldVal = oldValue[key];
      const newVal = newValue[key];
      return oldVal !== newVal;
    });
  }, [allKeys, oldValue, newValue]);

  if (changedFields.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No visible changes detected
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {changedFields.map(key => {
        const oldVal = oldValue[key];
        const newVal = newValue[key];
        const isLongText = (String(oldVal || '').length > 50) || (String(newVal || '').length > 50);

        return (
          <div key={key} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground capitalize">
                {key}
              </span>
              {key === fieldName && (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  changed
                </Badge>
              )}
            </div>

            {isLongText ? (
              // Stacked layout for long text
              <div className="space-y-1.5">
                {oldVal !== undefined && oldVal !== '' && (
                  <div className="flex items-start gap-2">
                    <Minus className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1 rounded-md border bg-destructive/10 border-destructive/20 p-2">
                      <span className="text-xs text-destructive break-words whitespace-pre-wrap">
                        {String(oldVal)}
                      </span>
                    </div>
                  </div>
                )}
                {newVal !== undefined && newVal !== '' && (
                  <div className="flex items-start gap-2">
                    <Plus className="h-3 w-3 text-success shrink-0 mt-0.5" />
                    <div className="flex-1 rounded-md border bg-success/10 border-success/20 p-2">
                      <span className="text-xs text-success break-words whitespace-pre-wrap">
                        {String(newVal)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              // Inline layout for short text
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {oldVal !== undefined && oldVal !== '' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/20">
                    <Minus className="h-2.5 w-2.5" />
                    {String(oldVal)}
                  </span>
                )}
                {oldVal !== undefined && newVal !== undefined && (
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                )}
                {newVal !== undefined && newVal !== '' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-success/10 text-success border border-success/20">
                    <Plus className="h-2.5 w-2.5" />
                    {String(newVal)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Export DiffSection for use in other components if needed
 */
export { DiffSection, FieldDiff };
export type { DiffSectionProps, FieldDiffProps };
