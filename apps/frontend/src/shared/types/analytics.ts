/**
 * Analytics and metrics types for task management dashboard
 */

import type { TaskStatus, TaskCategory, TaskComplexity, TaskPriority } from './task';

// Time period options for analytics queries
// - 'day': Daily metrics
// - 'week': Weekly aggregated metrics
// - 'month': Monthly aggregated metrics
// - 'quarter': Quarterly aggregated metrics
// - 'year': Yearly aggregated metrics
// - 'custom': Custom date range
export type AnalyticsPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

// Export format options
export type ExportFormat = 'csv' | 'pdf' | 'json';

/**
 * Represents daily task metrics stored in the task_metrics table
 * Maps to the task_metrics database table
 */
export interface TaskMetricsData {
  id: number;                          // Auto-incremented primary key
  projectId: string;                   // Project this metric belongs to
  metricDate: string;                  // Date of the metric (ISO date string, YYYY-MM-DD)
  totalTasks: number;                  // Total number of tasks on this date
  completedTasks: number;              // Number of completed tasks
  inProgressTasks: number;             // Number of in-progress tasks
  blockedTasks: number;                // Number of blocked/stuck tasks
  avgCompletionTimeHours: number | null;  // Average time to complete tasks in hours
  createdCount: number;                // Number of tasks created on this date
  completedCount: number;              // Number of tasks completed on this date
}

/**
 * Database row type for task_metrics table
 * Used internally for mapping database results to TaskMetricsData
 */
export interface DatabaseMetricsRow {
  id: number;
  project_id: string;
  metric_date: string;
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  blocked_tasks: number;
  avg_completion_time_hours: number | null;
  created_count: number;
  completed_count: number;
}

/**
 * Overview summary metrics for analytics dashboard
 * Aggregated data for a given time period
 */
export interface AnalyticsOverview {
  // Task counts
  totalTasks: number;                  // Total tasks in the period
  completedTasks: number;              // Tasks completed in the period
  inProgressTasks: number;             // Currently in-progress tasks
  backlogTasks: number;                // Tasks in backlog
  blockedTasks: number;                // Tasks that are blocked/stuck

  // Rates and percentages
  completionRate: number;              // Percentage of tasks completed (0-100)
  velocityPerDay: number;              // Average tasks completed per day
  velocityPerWeek: number;             // Average tasks completed per week

  // Time metrics
  avgCompletionTimeHours: number | null;  // Average time to complete a task
  avgCycleTimeHours: number | null;    // Average cycle time (start to finish)
  avgLeadTimeHours: number | null;     // Average lead time (created to finished)

  // Period info
  periodStart: string;                 // Start of the analysis period (ISO string)
  periodEnd: string;                   // End of the analysis period (ISO string)
  daysInPeriod: number;                // Number of days in the period

  // Comparison to previous period
  completionRateChange?: number;       // Change in completion rate vs previous period
  velocityChange?: number;             // Change in velocity vs previous period
  taskCountChange?: number;            // Change in total tasks vs previous period
}

/**
 * Single data point for trend charts
 */
export interface TrendDataPoint {
  date: string;                        // Date label (ISO date string)
  value: number;                       // Metric value for this date
  label?: string;                      // Optional display label
}

/**
 * Trend data for time-series charts
 * Contains multiple data series for different metrics
 */
export interface TrendData {
  period: AnalyticsPeriod;             // The period granularity of the data
  startDate: string;                   // Start of the trend period (ISO string)
  endDate: string;                     // End of the trend period (ISO string)

  // Data series for different metrics
  completedTasks: TrendDataPoint[];    // Tasks completed over time
  createdTasks: TrendDataPoint[];      // Tasks created over time
  totalTasks: TrendDataPoint[];        // Total tasks over time
  velocity: TrendDataPoint[];          // Velocity (completed per day) over time
  avgCompletionTime: TrendDataPoint[]; // Average completion time over time

  // Optional additional series
  inProgressTasks?: TrendDataPoint[];  // In-progress tasks over time
  backlogSize?: TrendDataPoint[];      // Backlog size over time
}

/**
 * Distribution data for pie/donut charts
 */
export interface DistributionDataPoint {
  name: string;                        // Category name (e.g., 'Done', 'In Progress')
  value: number;                       // Count or percentage
  percentage: number;                  // Percentage of total (0-100)
  color?: string;                      // Optional color for the segment
}

/**
 * Distribution breakdown by various categories
 */
export interface DistributionData {
  // Task status distribution
  byStatus: DistributionDataPoint[];

  // Optional breakdowns
  byCategory?: DistributionDataPoint[];     // By task category (feature, bug, etc.)
  byPriority?: DistributionDataPoint[];     // By priority (low, medium, high, urgent)
  byComplexity?: DistributionDataPoint[];   // By complexity (trivial to complex)
  byProject?: DistributionDataPoint[];      // By project

  // Totals
  totalTasks: number;                  // Total tasks in the distribution
}

/**
 * Velocity chart data for bar charts
 */
export interface VelocityDataPoint {
  period: string;                      // Period label (e.g., 'Week 1', 'January')
  completed: number;                   // Tasks completed in the period
  created: number;                     // Tasks created in the period
  netChange: number;                   // Net change (completed - created)
  target?: number;                     // Optional target for the period
}

/**
 * Velocity data for bar charts
 */
export interface VelocityData {
  periodType: AnalyticsPeriod;         // Granularity of the data
  dataPoints: VelocityDataPoint[];     // Data points for each period
  averageVelocity: number;             // Average velocity across all periods
  totalCompleted: number;              // Total completed across all periods
  totalCreated: number;                // Total created across all periods
}

/**
 * Query options for analytics API
 */
export interface AnalyticsQueryOptions {
  projectId?: string;                  // Filter by project (all projects if not specified)
  period?: AnalyticsPeriod;            // Time period granularity
  startDate?: string;                  // Custom start date (ISO string)
  endDate?: string;                    // Custom end date (ISO string)
  includeArchived?: boolean;           // Include archived tasks (default: false)
  compareToPrevious?: boolean;         // Include comparison to previous period
}

/**
 * Options for exporting analytics data
 */
export interface AnalyticsExportOptions {
  format: ExportFormat;                // Export format (csv, pdf, json)
  sections?: ('overview' | 'trends' | 'distribution' | 'velocity')[];  // Sections to include
  projectId?: string;                  // Filter by project
  startDate?: string;                  // Start date for export range
  endDate?: string;                    // End date for export range
  fileName?: string;                   // Custom filename (without extension)
  includeLogo?: boolean;               // Include logo in PDF export
}

/**
 * Result of analytics export
 */
export interface AnalyticsExportResult {
  success: boolean;                    // Whether export succeeded
  filePath?: string;                   // Path to the exported file
  data?: string;                       // Raw data (for JSON export)
  error?: string;                      // Error message if export failed
  bytesWritten?: number;               // Size of the exported file
}

/**
 * State for analytics UI
 */
export interface AnalyticsState {
  overview: AnalyticsOverview | null;  // Overview metrics
  trends: TrendData | null;            // Trend data for charts
  distribution: DistributionData | null; // Distribution data for pie charts
  velocity: VelocityData | null;       // Velocity data for bar charts

  // UI state
  isLoading: boolean;                  // Whether data is being fetched
  error?: string;                      // Error message if fetch failed
  selectedPeriod: AnalyticsPeriod;     // Currently selected time period
  dateRange: {
    start: string;                     // Selected start date
    end: string;                       // Selected end date
  };
  selectedProjectId?: string;          // Selected project filter
}

/**
 * Configuration for chart rendering
 */
export interface ChartConfig {
  showLegend?: boolean;                // Show chart legend
  showGrid?: boolean;                  // Show grid lines
  showTooltip?: boolean;               // Show tooltips on hover
  animate?: boolean;                   // Enable animations
  colors?: string[];                   // Custom color palette
  height?: number;                     // Chart height in pixels
}

/**
 * Default analytics configuration values
 */
export const DEFAULT_ANALYTICS_CONFIG = {
  defaultPeriod: 'month' as AnalyticsPeriod,
  defaultChartHeight: 300,
  maxDataPoints: 365,                  // Maximum data points to fetch
  refreshIntervalMs: 300000,           // Refresh every 5 minutes
  colors: [
    '#10b981', // emerald-500 (completed)
    '#3b82f6', // blue-500 (in progress)
    '#f59e0b', // amber-500 (backlog)
    '#ef4444', // red-500 (blocked)
    '#8b5cf6', // violet-500 (other)
  ],
};

/**
 * Helper function to calculate completion rate
 */
export function calculateCompletionRate(completed: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * Helper function to format hours to human-readable duration
 */
export function formatDuration(hours: number | null): string {
  if (hours === null || hours === 0) return 'N/A';

  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  } else if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  } else {
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
}

/**
 * Helper function to get default date range for a period
 */
export function getDefaultDateRange(period: AnalyticsPeriod): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().split('T')[0];
  let start: Date;

  switch (period) {
    case 'day':
      start = new Date(now);
      start.setDate(start.getDate() - 1);
      break;
    case 'week':
      start = new Date(now);
      start.setDate(start.getDate() - 7);
      break;
    case 'month':
      start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      break;
    case 'quarter':
      start = new Date(now);
      start.setMonth(start.getMonth() - 3);
      break;
    case 'year':
      start = new Date(now);
      start.setFullYear(start.getFullYear() - 1);
      break;
    default:
      // Custom - default to last 30 days
      start = new Date(now);
      start.setDate(start.getDate() - 30);
  }

  return {
    start: start.toISOString().split('T')[0],
    end,
  };
}
