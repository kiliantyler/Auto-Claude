import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  TaskMetricsData,
  AnalyticsOverview,
  TrendData,
  DistributionData,
  AnalyticsQueryOptions,
  AnalyticsPeriod,
  IPCResult
} from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/**
 * Productivity statistics for a time period
 */
export interface ProductivityStats {
  tasksCompleted: number;
  tasksCreated: number;
  avgCompletionTimeHours: number | null;
  peakProductivityHour: number | null;
  streakDays: number;
}

/**
 * Completion trend data point
 */
export interface CompletionTrendPoint {
  date: string;
  completed: number;
  created: number;
  netChange: number;
}

/**
 * Status distribution data point
 */
export interface StatusDistributionPoint {
  status: string;
  count: number;
  percentage: number;
}

/**
 * Analytics API operations for task metrics and insights
 * Phase 4D - Analytics & Reporting
 */
export interface AnalyticsAPI {
  // Task Metrics
  getTaskMetrics: (taskId: string) => Promise<IPCResult<TaskMetricsData | null>>;

  // Project Metrics (aggregated)
  getProjectMetrics: (
    projectId: string,
    options?: AnalyticsQueryOptions
  ) => Promise<IPCResult<AnalyticsOverview>>;

  // Productivity Statistics
  getProductivityStats: (
    projectId?: string,
    period?: AnalyticsPeriod
  ) => Promise<IPCResult<ProductivityStats>>;

  // Completion Trends (time series)
  getCompletionTrends: (
    projectId?: string,
    options?: AnalyticsQueryOptions
  ) => Promise<IPCResult<TrendData>>;

  // Status Distribution (pie chart data)
  getStatusDistribution: (
    projectId?: string
  ) => Promise<IPCResult<DistributionData>>;

  // Feature Flag
  isEnabled: () => Promise<IPCResult<boolean>>;

  // Cache Refresh
  refresh: (projectId?: string) => Promise<IPCResult<void>>;
}

/**
 * Creates the Analytics API implementation
 */
export const createAnalyticsAPI = (): AnalyticsAPI => ({
  // Task Metrics
  getTaskMetrics: (taskId: string): Promise<IPCResult<TaskMetricsData | null>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_GET_TASK_METRICS, taskId),

  // Project Metrics (aggregated)
  getProjectMetrics: (
    projectId: string,
    options?: AnalyticsQueryOptions
  ): Promise<IPCResult<AnalyticsOverview>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_GET_PROJECT_METRICS, projectId, options),

  // Productivity Statistics
  getProductivityStats: (
    projectId?: string,
    period?: AnalyticsPeriod
  ): Promise<IPCResult<ProductivityStats>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_GET_PRODUCTIVITY_STATS, projectId, period),

  // Completion Trends (time series)
  getCompletionTrends: (
    projectId?: string,
    options?: AnalyticsQueryOptions
  ): Promise<IPCResult<TrendData>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_GET_COMPLETION_TRENDS, projectId, options),

  // Status Distribution (pie chart data)
  getStatusDistribution: (
    projectId?: string
  ): Promise<IPCResult<DistributionData>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_GET_STATUS_DISTRIBUTION, projectId),

  // Feature Flag
  isEnabled: (): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_IS_ENABLED),

  // Cache Refresh
  refresh: (projectId?: string): Promise<IPCResult<void>> =>
    invokeIpc(IPC_CHANNELS.ANALYTICS_REFRESH, projectId)
});
