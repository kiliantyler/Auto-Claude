import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  TooltipProps,
  ReferenceLine,
} from 'recharts';
import { BarChart3, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { VelocityData, ChartConfig } from '../../../shared/types';
import { DEFAULT_ANALYTICS_CONFIG } from '../../../shared/types/analytics';

/**
 * Props for the VelocityChart component
 */
interface VelocityChartProps {
  /** Velocity data to display */
  data: VelocityData | null;
  /** Whether the data is currently loading */
  isLoading?: boolean;
  /** Chart configuration options */
  config?: ChartConfig;
  /** Additional CSS classes */
  className?: string;
  /** Show net change bars (default: true) */
  showNetChange?: boolean;
  /** Show target reference line */
  showTarget?: boolean;
  /** Show stacked bars instead of grouped (default: false) */
  stacked?: boolean;
}

/**
 * Transformed chart data point for display
 */
interface ChartDataPoint {
  period: string;
  completed: number;
  created: number;
  netChange: number;
  target?: number;
}

/**
 * Series configuration for bar chart
 */
interface SeriesConfig {
  key: keyof Omit<ChartDataPoint, 'period'>;
  name: string;
  color: string;
}

/**
 * Default series configurations
 */
const SERIES_CONFIG: Record<string, SeriesConfig> = {
  completed: {
    key: 'completed',
    name: 'Completed',
    color: DEFAULT_ANALYTICS_CONFIG.colors[0], // emerald-500
  },
  created: {
    key: 'created',
    name: 'Created',
    color: DEFAULT_ANALYTICS_CONFIG.colors[1], // blue-500
  },
  netChange: {
    key: 'netChange',
    name: 'Net Change',
    color: DEFAULT_ANALYTICS_CONFIG.colors[4], // violet-500
  },
};

/**
 * Custom tooltip component for the bar chart
 */
function CustomTooltip({
  active,
  payload,
  label,
}: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  // Calculate net change for display
  const completed = payload.find((p) => p.dataKey === 'completed')?.value ?? 0;
  const created = payload.find((p) => p.dataKey === 'created')?.value ?? 0;
  const netChange = (completed as number) - (created as number);

  return (
    <div className="rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
      <p className="mb-2 text-sm font-medium text-foreground">{label}</p>
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={entry.dataKey} className="flex items-center gap-2 text-sm">
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-muted-foreground">{entry.name}:</span>
            <span className="font-medium text-foreground">
              {typeof entry.value === 'number' ? entry.value : 0}
            </span>
          </div>
        ))}
        <div className="mt-2 pt-2 border-t border-border">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Net:</span>
            <span
              className={cn(
                'font-medium',
                netChange > 0 && 'text-red-500',
                netChange < 0 && 'text-emerald-500',
                netChange === 0 && 'text-muted-foreground'
              )}
            >
              {netChange > 0 ? '+' : ''}
              {netChange}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Transform VelocityData into chart-ready data points
 */
function transformData(data: VelocityData): ChartDataPoint[] {
  return data.dataPoints.map((point) => ({
    period: point.period,
    completed: point.completed,
    created: point.created,
    netChange: point.netChange,
    target: point.target,
  }));
}

/**
 * VelocityChart component
 *
 * Displays task velocity data using Recharts BarChart.
 * Shows tasks completed vs created per period with optional net change.
 *
 * Phase 4D - Analytics & Reporting
 *
 * @example
 * ```tsx
 * <VelocityChart
 *   data={velocityData}
 *   showNetChange={true}
 *   isLoading={false}
 * />
 * ```
 */
export function VelocityChart({
  data,
  isLoading = false,
  config,
  className,
  showNetChange = false,
  showTarget = false,
  stacked = false,
}: VelocityChartProps) {
  // Chart configuration with defaults
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      showLegend: true,
      showGrid: true,
      showTooltip: true,
      animate: true,
      height: DEFAULT_ANALYTICS_CONFIG.defaultChartHeight,
      colors: DEFAULT_ANALYTICS_CONFIG.colors,
      ...config,
    }),
    [config]
  );

  // Transform data for chart
  const chartData = useMemo(() => {
    if (!data) return [];
    return transformData(data);
  }, [data]);

  // Calculate average velocity for reference line
  const averageVelocity = data?.averageVelocity ?? 0;

  // Check if any data points have targets
  const hasTargets = showTarget && chartData.some((point) => point.target !== undefined);

  // Loading state
  if (isLoading) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg bg-muted/20 animate-pulse',
          className
        )}
        style={{ height: chartConfig.height }}
      >
        <div className="flex items-center gap-2 text-muted-foreground">
          <BarChart3 className="h-5 w-5" />
          <span>Loading velocity data...</span>
        </div>
      </div>
    );
  }

  // Empty state - no data
  if (!data || chartData.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/10',
          className
        )}
        style={{ height: chartConfig.height }}
      >
        <Zap className="h-10 w-10 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">No velocity data available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Data will appear once tasks are tracked
        </p>
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)} style={{ height: chartConfig.height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          margin={{
            top: 5,
            right: 30,
            left: 20,
            bottom: 5,
          }}
        >
          {chartConfig.showGrid && (
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="hsl(var(--border))"
              opacity={0.5}
            />
          )}

          <XAxis
            dataKey="period"
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
            tickLine={{ stroke: 'hsl(var(--border))' }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
          />

          <YAxis
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
            tickLine={{ stroke: 'hsl(var(--border))' }}
            axisLine={{ stroke: 'hsl(var(--border))' }}
            allowDecimals={false}
          />

          {chartConfig.showTooltip && (
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ fill: 'hsl(var(--muted))', opacity: 0.3 }}
            />
          )}

          {chartConfig.showLegend && (
            <Legend
              verticalAlign="top"
              height={36}
              wrapperStyle={{
                paddingBottom: '10px',
              }}
              formatter={(value: string) => (
                <span className="text-sm text-muted-foreground">{value}</span>
              )}
            />
          )}

          {/* Average velocity reference line */}
          {averageVelocity > 0 && (
            <ReferenceLine
              y={averageVelocity}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="5 5"
              label={{
                value: `Avg: ${averageVelocity.toFixed(1)}`,
                fill: 'hsl(var(--muted-foreground))',
                fontSize: 10,
                position: 'right',
              }}
            />
          )}

          {/* Completed tasks bar */}
          <Bar
            dataKey="completed"
            name={SERIES_CONFIG.completed.name}
            fill={SERIES_CONFIG.completed.color}
            stackId={stacked ? 'stack' : undefined}
            isAnimationActive={chartConfig.animate}
            animationDuration={500}
            radius={stacked ? [0, 0, 4, 4] : [4, 4, 0, 0]}
          />

          {/* Created tasks bar */}
          <Bar
            dataKey="created"
            name={SERIES_CONFIG.created.name}
            fill={SERIES_CONFIG.created.color}
            stackId={stacked ? 'stack' : undefined}
            isAnimationActive={chartConfig.animate}
            animationDuration={500}
            radius={stacked ? [4, 4, 0, 0] : [4, 4, 0, 0]}
          />

          {/* Net change bar (optional) */}
          {showNetChange && (
            <Bar
              dataKey="netChange"
              name={SERIES_CONFIG.netChange.name}
              fill={SERIES_CONFIG.netChange.color}
              isAnimationActive={chartConfig.animate}
              animationDuration={500}
              radius={[4, 4, 0, 0]}
            />
          )}

          {/* Target reference lines (optional) */}
          {hasTargets && chartData[0].target !== undefined && (
            <ReferenceLine
              y={chartData[0].target}
              stroke="#f59e0b"
              strokeDasharray="3 3"
              label={{
                value: `Target: ${chartData[0].target}`,
                fill: '#f59e0b',
                fontSize: 10,
                position: 'left',
              }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * VelocityChart with Card wrapper for standalone use
 */
export function VelocityChartCard({
  data,
  isLoading = false,
  config,
  className,
  showNetChange = false,
  showTarget = false,
  stacked = false,
  title = 'Task Velocity',
  description = 'Tasks completed vs created per period',
}: VelocityChartProps & {
  title?: string;
  description?: string;
}) {
  // Calculate summary stats
  const totalCompleted = data?.totalCompleted ?? 0;
  const totalCreated = data?.totalCreated ?? 0;
  const averageVelocity = data?.averageVelocity ?? 0;

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-6',
        className
      )}
    >
      <div className="mb-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Zap className="h-5 w-5 text-primary" />
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {data && (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span>
              Completed: <span className="font-medium text-emerald-500">{totalCompleted}</span>
            </span>
            <span>
              Created: <span className="font-medium text-blue-500">{totalCreated}</span>
            </span>
            <span>
              Avg: <span className="font-medium text-foreground">{averageVelocity.toFixed(1)}/period</span>
            </span>
          </div>
        )}
      </div>
      <VelocityChart
        data={data}
        isLoading={isLoading}
        config={config}
        showNetChange={showNetChange}
        showTarget={showTarget}
        stacked={stacked}
      />
    </div>
  );
}

export default VelocityChart;
