import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  TooltipProps,
} from 'recharts';
import { TrendingUp, BarChart3 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { TrendData, TrendDataPoint, ChartConfig } from '../../../shared/types';
import { DEFAULT_ANALYTICS_CONFIG } from '../../../shared/types/analytics';

/**
 * Props for the TrendsChart component
 */
interface TrendsChartProps {
  /** Trend data to display */
  data: TrendData | null;
  /** Whether the data is currently loading */
  isLoading?: boolean;
  /** Chart configuration options */
  config?: ChartConfig;
  /** Additional CSS classes */
  className?: string;
  /** Which series to show (default: completed, created) */
  series?: ('completed' | 'created' | 'total' | 'velocity' | 'avgCompletionTime')[];
}

/**
 * Type for the transformed chart data point
 */
interface ChartDataPoint {
  date: string;
  displayDate: string;
  completed?: number;
  created?: number;
  total?: number;
  velocity?: number;
  avgCompletionTime?: number;
}

/**
 * Series configuration for chart lines
 */
interface SeriesConfig {
  key: keyof Omit<ChartDataPoint, 'date' | 'displayDate'>;
  name: string;
  color: string;
  dataKey: keyof TrendData;
}

/**
 * Default series configuration
 */
const SERIES_CONFIG: Record<string, SeriesConfig> = {
  completed: {
    key: 'completed',
    name: 'Completed',
    color: DEFAULT_ANALYTICS_CONFIG.colors[0], // emerald-500
    dataKey: 'completedTasks',
  },
  created: {
    key: 'created',
    name: 'Created',
    color: DEFAULT_ANALYTICS_CONFIG.colors[1], // blue-500
    dataKey: 'createdTasks',
  },
  total: {
    key: 'total',
    name: 'Total',
    color: DEFAULT_ANALYTICS_CONFIG.colors[4], // violet-500
    dataKey: 'totalTasks',
  },
  velocity: {
    key: 'velocity',
    name: 'Velocity',
    color: DEFAULT_ANALYTICS_CONFIG.colors[2], // amber-500
    dataKey: 'velocity',
  },
  avgCompletionTime: {
    key: 'avgCompletionTime',
    name: 'Avg Time (h)',
    color: DEFAULT_ANALYTICS_CONFIG.colors[3], // red-500
    dataKey: 'avgCompletionTime',
  },
};

/**
 * Custom tooltip component for the line chart
 */
function CustomTooltip({
  active,
  payload,
  label,
}: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

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
              {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Format date string for display on X-axis
 */
function formatDateLabel(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateString;
  }
}

/**
 * Transform TrendData into chart-ready data points
 */
function transformData(
  data: TrendData,
  series: ('completed' | 'created' | 'total' | 'velocity' | 'avgCompletionTime')[]
): ChartDataPoint[] {
  // Get all unique dates from all series
  const allDates = new Set<string>();

  series.forEach((s) => {
    const config = SERIES_CONFIG[s];
    const dataPoints = data[config.dataKey] as TrendDataPoint[] | undefined;
    dataPoints?.forEach((point) => allDates.add(point.date));
  });

  // Sort dates chronologically
  const sortedDates = Array.from(allDates).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );

  // Build chart data points
  return sortedDates.map((date) => {
    const point: ChartDataPoint = {
      date,
      displayDate: formatDateLabel(date),
    };

    series.forEach((s) => {
      const config = SERIES_CONFIG[s];
      const dataPoints = data[config.dataKey] as TrendDataPoint[] | undefined;
      const dataPoint = dataPoints?.find((p) => p.date === date);
      if (dataPoint) {
        point[config.key] = dataPoint.value;
      }
    });

    return point;
  });
}

/**
 * TrendsChart component
 *
 * Displays task trends over time using Recharts LineChart.
 * Shows multiple series (completed, created, etc.) with interactive tooltips.
 *
 * Phase 4D - Analytics & Reporting
 *
 * @example
 * ```tsx
 * <TrendsChart
 *   data={trendData}
 *   series={['completed', 'created']}
 *   isLoading={false}
 * />
 * ```
 */
export function TrendsChart({
  data,
  isLoading = false,
  config,
  className,
  series = ['completed', 'created'],
}: TrendsChartProps) {
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
    return transformData(data, series);
  }, [data, series]);

  // Get active series configurations
  const activeSeries = useMemo(() => {
    return series
      .map((s) => SERIES_CONFIG[s])
      .filter((config): config is SeriesConfig => config !== undefined);
  }, [series]);

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
          <TrendingUp className="h-5 w-5" />
          <span>Loading trend data...</span>
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
        <BarChart3 className="h-10 w-10 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">No trend data available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Data will appear once tasks are tracked
        </p>
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)} style={{ height: chartConfig.height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
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
            dataKey="displayDate"
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
              cursor={{ stroke: 'hsl(var(--border))' }}
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

          {activeSeries.map((seriesConfig) => (
            <Line
              key={seriesConfig.key}
              type="monotone"
              dataKey={seriesConfig.key}
              name={seriesConfig.name}
              stroke={seriesConfig.color}
              strokeWidth={2}
              dot={{
                fill: seriesConfig.color,
                strokeWidth: 2,
                r: 3,
              }}
              activeDot={{
                fill: seriesConfig.color,
                strokeWidth: 2,
                r: 5,
              }}
              isAnimationActive={chartConfig.animate}
              animationDuration={500}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * TrendsChart with Card wrapper for standalone use
 */
export function TrendsChartCard({
  data,
  isLoading = false,
  config,
  className,
  series = ['completed', 'created'],
  title = 'Completion Trends',
  description = 'Tasks completed over time',
}: TrendsChartProps & {
  title?: string;
  description?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-6',
        className
      )}
    >
      <div className="mb-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <TrendingUp className="h-5 w-5 text-primary" />
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <TrendsChart
        data={data}
        isLoading={isLoading}
        config={config}
        series={series}
      />
    </div>
  );
}

export default TrendsChart;
