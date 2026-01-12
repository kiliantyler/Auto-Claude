import { useMemo } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  Clock,
  ListTodo,
  Zap,
  BarChart3
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { cn } from '../../lib/utils';
import type { AnalyticsOverview } from '../../../shared/types';
import { formatDuration } from '../../../shared/types/analytics';

/**
 * Props for the MetricsOverview component
 */
interface MetricsOverviewProps {
  /** Analytics overview data to display */
  data: AnalyticsOverview | null;
  /** Whether the data is currently loading */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Configuration for a single metric card
 */
interface MetricCardConfig {
  id: string;
  label: string;
  getValue: (data: AnalyticsOverview) => string | number;
  getChange: (data: AnalyticsOverview) => number | undefined;
  getSubtext: (data: AnalyticsOverview) => string;
  icon: React.ReactNode;
  changeLabel?: string;
}

/**
 * Renders a trend indicator with arrow icon
 */
function TrendIndicator({
  change,
  label = 'vs previous period',
}: {
  change: number | undefined;
  label?: string;
}) {
  if (change === undefined) {
    return (
      <span className="text-muted-foreground">
        {label}
      </span>
    );
  }

  const isPositive = change >= 0;
  const isNeutral = change === 0;

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          'inline-flex items-center font-medium',
          isNeutral
            ? 'text-muted-foreground'
            : isPositive
              ? 'text-emerald-500'
              : 'text-red-500'
        )}
      >
        {isNeutral ? (
          <Minus className="h-3 w-3" />
        ) : isPositive ? (
          <TrendingUp className="h-3 w-3" />
        ) : (
          <TrendingDown className="h-3 w-3" />
        )}
        {isPositive && !isNeutral ? '+' : ''}
        {change.toFixed(1)}%
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * Single metric card component
 */
function MetricCard({
  config,
  data,
  isLoading,
}: {
  config: MetricCardConfig;
  data: AnalyticsOverview | null;
  isLoading?: boolean;
}) {
  const value = data ? config.getValue(data) : '--';
  const change = data ? config.getChange(data) : undefined;
  const subtext = data ? config.getSubtext(data) : '';

  return (
    <Card
      className={cn(
        'transition-all duration-200 hover:shadow-md',
        isLoading && 'animate-pulse'
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardDescription className="flex items-center gap-2">
            {config.icon}
            {config.label}
          </CardDescription>
        </div>
        <CardTitle
          className={cn(
            'text-3xl font-bold tracking-tight',
            isLoading && 'bg-muted rounded h-9 w-20'
          )}
        >
          {!isLoading && value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={cn(
          'text-sm',
          isLoading && 'bg-muted rounded h-4 w-32'
        )}>
          {!isLoading && (
            subtext ? (
              <span className="text-muted-foreground">{subtext}</span>
            ) : (
              <TrendIndicator change={change} label={config.changeLabel} />
            )
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * MetricsOverview component
 *
 * Displays summary cards for key analytics metrics including:
 * - Total Tasks (with change percentage)
 * - Completed Tasks (with completion rate)
 * - In Progress Tasks
 * - Velocity (tasks per week with change percentage)
 *
 * Phase 4D - Analytics & Reporting
 *
 * @example
 * ```tsx
 * <MetricsOverview data={analyticsOverview} isLoading={false} />
 * ```
 */
export function MetricsOverview({
  data,
  isLoading = false,
  className,
}: MetricsOverviewProps) {
  /**
   * Configuration for the 4 metric cards
   */
  const metricCards = useMemo<MetricCardConfig[]>(
    () => [
      {
        id: 'total-tasks',
        label: 'Total Tasks',
        getValue: (d) => d.totalTasks,
        getChange: (d) => d.taskCountChange,
        getSubtext: () => '',
        icon: <ListTodo className="h-4 w-4" />,
        changeLabel: 'vs previous period',
      },
      {
        id: 'completed-tasks',
        label: 'Completed',
        getValue: (d) => d.completedTasks,
        getChange: () => undefined,
        getSubtext: (d) => `${d.completionRate}% completion rate`,
        icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
      },
      {
        id: 'in-progress-tasks',
        label: 'In Progress',
        getValue: (d) => d.inProgressTasks,
        getChange: () => undefined,
        getSubtext: () => 'Currently being worked on',
        icon: <Clock className="h-4 w-4 text-blue-500" />,
      },
      {
        id: 'velocity',
        label: 'Velocity',
        getValue: (d) => d.velocityPerWeek.toFixed(1),
        getChange: (d) => d.velocityChange,
        getSubtext: (d) => {
          if (d.velocityChange !== undefined) {
            return '';
          }
          return 'tasks/week';
        },
        icon: <Zap className="h-4 w-4 text-amber-500" />,
        changeLabel: 'tasks/week',
      },
    ],
    []
  );

  // Empty state when no data and not loading
  if (!data && !isLoading) {
    return (
      <Card className={cn('p-8', className)}>
        <div className="text-center text-muted-foreground">
          <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No metrics data available</p>
        </div>
      </Card>
    );
  }

  return (
    <div
      className={cn(
        'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4',
        className
      )}
    >
      {metricCards.map((config) => (
        <MetricCard
          key={config.id}
          config={config}
          data={data}
          isLoading={isLoading}
        />
      ))}
    </div>
  );
}

/**
 * Extended MetricsOverview with additional metric cards
 * Use this when you need to display more detailed metrics
 */
export function MetricsOverviewExtended({
  data,
  isLoading = false,
  className,
}: MetricsOverviewProps) {
  const extendedMetrics = useMemo<MetricCardConfig[]>(
    () => [
      {
        id: 'backlog',
        label: 'Backlog',
        getValue: (d) => d.backlogTasks,
        getChange: () => undefined,
        getSubtext: () => 'Waiting to start',
        icon: <ListTodo className="h-4 w-4 text-slate-500" />,
      },
      {
        id: 'blocked',
        label: 'Blocked',
        getValue: (d) => d.blockedTasks,
        getChange: () => undefined,
        getSubtext: () => 'Requires attention',
        icon: <Clock className="h-4 w-4 text-red-500" />,
      },
      {
        id: 'avg-completion-time',
        label: 'Avg Completion Time',
        getValue: (d) => formatDuration(d.avgCompletionTimeHours),
        getChange: () => undefined,
        getSubtext: () => 'Per task',
        icon: <Clock className="h-4 w-4 text-purple-500" />,
      },
      {
        id: 'velocity-daily',
        label: 'Daily Velocity',
        getValue: (d) => d.velocityPerDay.toFixed(1),
        getChange: () => undefined,
        getSubtext: () => 'Tasks/day',
        icon: <Zap className="h-4 w-4 text-amber-500" />,
      },
    ],
    []
  );

  // Base metrics (same as MetricsOverview)
  const baseMetrics = useMemo<MetricCardConfig[]>(
    () => [
      {
        id: 'total-tasks',
        label: 'Total Tasks',
        getValue: (d) => d.totalTasks,
        getChange: (d) => d.taskCountChange,
        getSubtext: () => '',
        icon: <ListTodo className="h-4 w-4" />,
        changeLabel: 'vs previous period',
      },
      {
        id: 'completed-tasks',
        label: 'Completed',
        getValue: (d) => d.completedTasks,
        getChange: () => undefined,
        getSubtext: (d) => `${d.completionRate}% completion rate`,
        icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" />,
      },
      {
        id: 'in-progress-tasks',
        label: 'In Progress',
        getValue: (d) => d.inProgressTasks,
        getChange: () => undefined,
        getSubtext: () => 'Currently being worked on',
        icon: <Clock className="h-4 w-4 text-blue-500" />,
      },
      {
        id: 'velocity',
        label: 'Velocity',
        getValue: (d) => d.velocityPerWeek.toFixed(1),
        getChange: (d) => d.velocityChange,
        getSubtext: (d) => {
          if (d.velocityChange !== undefined) {
            return '';
          }
          return 'tasks/week';
        },
        icon: <Zap className="h-4 w-4 text-amber-500" />,
        changeLabel: 'tasks/week',
      },
    ],
    []
  );

  const allMetrics = [...baseMetrics, ...extendedMetrics];

  // Empty state when no data and not loading
  if (!data && !isLoading) {
    return (
      <Card className={cn('p-8', className)}>
        <div className="text-center text-muted-foreground">
          <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>No metrics data available</p>
        </div>
      </Card>
    );
  }

  return (
    <div
      className={cn(
        'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4',
        className
      )}
    >
      {allMetrics.map((config) => (
        <MetricCard
          key={config.id}
          config={config}
          data={data}
          isLoading={isLoading}
        />
      ))}
    </div>
  );
}

export default MetricsOverview;
