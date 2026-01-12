import { useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  TooltipProps,
} from 'recharts';
import { PieChartIcon, BarChart3 } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { DistributionData, DistributionDataPoint, ChartConfig } from '../../../shared/types';
import { DEFAULT_ANALYTICS_CONFIG } from '../../../shared/types/analytics';

/**
 * Props for the DistributionChart component
 */
interface DistributionChartProps {
  /** Distribution data to display */
  data: DistributionData | null;
  /** Whether the data is currently loading */
  isLoading?: boolean;
  /** Chart configuration options */
  config?: ChartConfig;
  /** Additional CSS classes */
  className?: string;
  /** Which distribution to show (default: byStatus) */
  distributionType?: 'byStatus' | 'byCategory' | 'byPriority' | 'byComplexity' | 'byProject';
  /** Show as donut chart (with inner radius) */
  donut?: boolean;
  /** Show labels on segments */
  showLabels?: boolean;
}

/**
 * Transform distribution data for the chart
 */
interface ChartDataPoint {
  name: string;
  value: number;
  percentage: number;
  color: string;
}

/**
 * Default colors for distribution segments when not specified
 */
const DEFAULT_STATUS_COLORS: Record<string, string> = {
  'completed': '#10b981', // emerald-500
  'done': '#10b981',
  'in_progress': '#3b82f6', // blue-500
  'in progress': '#3b82f6',
  'backlog': '#f59e0b', // amber-500
  'todo': '#f59e0b',
  'blocked': '#ef4444', // red-500
  'stuck': '#ef4444',
  'review': '#8b5cf6', // violet-500
  'cancelled': '#6b7280', // gray-500
};

/**
 * Get color for a data point
 */
function getColor(point: DistributionDataPoint, index: number): string {
  // Use explicitly set color if available
  if (point.color) return point.color;

  // Try to match by name (case-insensitive)
  const normalizedName = point.name.toLowerCase().replace(/[-_]/g, ' ');
  if (DEFAULT_STATUS_COLORS[normalizedName]) {
    return DEFAULT_STATUS_COLORS[normalizedName];
  }

  // Fall back to default palette
  return DEFAULT_ANALYTICS_CONFIG.colors[index % DEFAULT_ANALYTICS_CONFIG.colors.length];
}

/**
 * Custom tooltip component for the pie chart
 */
function CustomTooltip({
  active,
  payload,
}: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const data = payload[0].payload as ChartDataPoint;

  return (
    <div className="rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 mb-1">
        <div
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: data.color }}
        />
        <span className="font-medium text-foreground">{data.name}</span>
      </div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Count:</span>
          <span className="font-medium text-foreground">{data.value}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Percentage:</span>
          <span className="font-medium text-foreground">{data.percentage.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Custom label renderer for pie segments
 */
function renderCustomLabel({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  percent,
  name,
}: {
  cx: number;
  cy: number;
  midAngle: number;
  innerRadius: number;
  outerRadius: number;
  percent: number;
  name: string;
}) {
  // Only show label if segment is large enough (> 5%)
  if (percent < 0.05) return null;

  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      fill="white"
      textAnchor="middle"
      dominantBaseline="central"
      className="text-xs font-medium"
      style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
    >
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

/**
 * Custom legend formatter
 */
function renderLegendText(value: string, entry: { color?: string; payload?: ChartDataPoint }) {
  const percentage = entry.payload?.percentage ?? 0;
  return (
    <span className="text-sm text-muted-foreground">
      {value} ({percentage.toFixed(1)}%)
    </span>
  );
}

/**
 * Transform DistributionData into chart-ready data points
 */
function transformData(
  data: DistributionData,
  distributionType: DistributionChartProps['distributionType']
): ChartDataPoint[] {
  let dataPoints: DistributionDataPoint[];

  switch (distributionType) {
    case 'byCategory':
      dataPoints = data.byCategory ?? [];
      break;
    case 'byPriority':
      dataPoints = data.byPriority ?? [];
      break;
    case 'byComplexity':
      dataPoints = data.byComplexity ?? [];
      break;
    case 'byProject':
      dataPoints = data.byProject ?? [];
      break;
    case 'byStatus':
    default:
      dataPoints = data.byStatus;
  }

  return dataPoints
    .filter((point) => point.value > 0)
    .map((point, index) => ({
      name: point.name,
      value: point.value,
      percentage: point.percentage,
      color: getColor(point, index),
    }));
}

/**
 * DistributionChart component
 *
 * Displays task distribution using Recharts PieChart.
 * Shows task counts by status, category, priority, etc.
 * with interactive tooltips and legend.
 *
 * Phase 4D - Analytics & Reporting
 *
 * @example
 * ```tsx
 * <DistributionChart
 *   data={distributionData}
 *   distributionType="byStatus"
 *   donut={true}
 *   isLoading={false}
 * />
 * ```
 */
export function DistributionChart({
  data,
  isLoading = false,
  config,
  className,
  distributionType = 'byStatus',
  donut = false,
  showLabels = true,
}: DistributionChartProps) {
  // Chart configuration with defaults
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      showLegend: true,
      showGrid: false,
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
    return transformData(data, distributionType);
  }, [data, distributionType]);

  // Calculate inner/outer radius based on donut setting
  const innerRadius = donut ? '55%' : 0;
  const outerRadius = '80%';

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
          <PieChartIcon className="h-5 w-5" />
          <span>Loading distribution data...</span>
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
        <p className="text-sm text-muted-foreground">No distribution data available</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Data will appear once tasks are tracked
        </p>
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)} style={{ height: chartConfig.height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={chartData.length > 1 ? 2 : 0}
            isAnimationActive={chartConfig.animate}
            animationDuration={500}
            label={showLabels ? renderCustomLabel : undefined}
            labelLine={false}
          >
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.color}
                stroke="hsl(var(--background))"
                strokeWidth={2}
              />
            ))}
          </Pie>

          {chartConfig.showTooltip && (
            <Tooltip content={<CustomTooltip />} />
          )}

          {chartConfig.showLegend && (
            <Legend
              verticalAlign="bottom"
              height={36}
              formatter={renderLegendText}
              wrapperStyle={{
                paddingTop: '10px',
              }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * DistributionChart with Card wrapper for standalone use
 */
export function DistributionChartCard({
  data,
  isLoading = false,
  config,
  className,
  distributionType = 'byStatus',
  donut = false,
  showLabels = true,
  title = 'Status Distribution',
  description = 'Tasks by current status',
}: DistributionChartProps & {
  title?: string;
  description?: string;
}) {
  // Get total count for subtitle
  const totalTasks = data?.totalTasks ?? 0;

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-6',
        className
      )}
    >
      <div className="mb-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <PieChartIcon className="h-5 w-5 text-primary" />
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">
          {description}
          {totalTasks > 0 && (
            <span className="ml-1">({totalTasks} total)</span>
          )}
        </p>
      </div>
      <DistributionChart
        data={data}
        isLoading={isLoading}
        config={config}
        distributionType={distributionType}
        donut={donut}
        showLabels={showLabels}
      />
    </div>
  );
}

export default DistributionChart;
