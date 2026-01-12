/**
 * Analytics IPC Handlers
 * ======================
 *
 * IPC handlers for task analytics and reporting operations.
 * These handlers expose the AnalyticsService to the renderer process.
 *
 * Available handlers:
 * - analytics:overview - Get overview metrics for a date range
 * - analytics:trends - Get trend data for time-series charts
 * - analytics:distribution - Get distribution data for pie/bar charts
 * - analytics:export - Export analytics data to CSV, PDF, or JSON
 * - analytics:is-enabled - Check if analytics feature is enabled
 * - analytics:calculate-daily-metrics - Calculate and store daily metrics
 * - analytics:get-stored-metrics - Get stored metrics from the database
 */

import { ipcMain } from 'electron';
import type {
  IPCResult,
  AnalyticsOverview,
  TrendData,
  DistributionData,
  AnalyticsQueryOptions,
  AnalyticsExportOptions,
  AnalyticsExportResult,
  TaskMetricsData,
} from '../../shared/types';
import { getAnalyticsService } from '../analytics-service';
import { projectStore } from '../project-store';

// IPC channel names for analytics operations
export const ANALYTICS_CHANNELS = {
  OVERVIEW: 'analytics:overview',
  TRENDS: 'analytics:trends',
  DISTRIBUTION: 'analytics:distribution',
  EXPORT: 'analytics:export',
  IS_ENABLED: 'analytics:is-enabled',
  CALCULATE_DAILY_METRICS: 'analytics:calculate-daily-metrics',
  GET_STORED_METRICS: 'analytics:get-stored-metrics',
  CLEANUP_OLD_METRICS: 'analytics:cleanup-old-metrics',
} as const;

/**
 * Helper to get project path from projectId
 */
function getProjectPath(projectId: string): string | null {
  const project = projectStore.getProject(projectId);
  if (!project) {
    console.warn(`[Analytics Handlers] Project not found: ${projectId}`);
    return null;
  }
  return project.path;
}

/**
 * Register analytics IPC handlers
 *
 * Follows the same pattern as history-handlers.ts - simple registration function
 * that sets up all handlers when called.
 */
export function registerAnalyticsHandlers(): void {
  console.log('[Analytics Handlers] Registering analytics IPC handlers');

  /**
   * Check if analytics feature is enabled
   * Returns true if ENABLE_ANALYTICS is not set to 'false'
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.IS_ENABLED,
    async (): Promise<IPCResult<boolean>> => {
      try {
        const service = getAnalyticsService();
        const enabled = service.isEnabled();
        return { success: true, data: enabled };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to check if analytics is enabled:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check analytics status',
        };
      }
    }
  );

  /**
   * Get overview metrics for a date range
   *
   * Returns aggregated metrics including totals, rates, and velocities.
   *
   * @param projectId - Project ID (required)
   * @param options - Query options (date range, project filter, compare to previous)
   * @returns AnalyticsOverview with aggregated metrics
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.OVERVIEW,
    async (_, projectId: string, options?: AnalyticsQueryOptions): Promise<IPCResult<AnalyticsOverview>> => {
      console.log('[Analytics Handlers] OVERVIEW called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const overview = service.getOverview(projectPath, options);
        console.log(
          '[Analytics Handlers] OVERVIEW returning metrics for',
          overview.daysInPeriod,
          'days'
        );
        return { success: true, data: overview };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to get overview:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get analytics overview',
        };
      }
    }
  );

  /**
   * Get trend data for time-series charts
   *
   * Returns data points for each day/week/month in the specified period.
   *
   * @param projectId - Project ID (required)
   * @param options - Query options (period, date range, project filter)
   * @returns TrendData with multiple data series
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.TRENDS,
    async (_, projectId: string, options?: AnalyticsQueryOptions): Promise<IPCResult<TrendData>> => {
      console.log('[Analytics Handlers] TRENDS called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const trends = service.getTrends(projectPath, options);
        console.log(
          '[Analytics Handlers] TRENDS returning',
          trends.completedTasks.length,
          'data points'
        );
        return { success: true, data: trends };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to get trends:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get trend data',
        };
      }
    }
  );

  /**
   * Get distribution data for pie/bar charts
   *
   * Returns task counts grouped by status, category, priority, etc.
   *
   * @param projectId - Project ID (required)
   * @param options - Query options (project filter)
   * @returns DistributionData with multiple breakdowns
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.DISTRIBUTION,
    async (_, projectId: string, options?: AnalyticsQueryOptions): Promise<IPCResult<DistributionData>> => {
      console.log('[Analytics Handlers] DISTRIBUTION called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const distribution = service.getDistribution(projectPath, options);
        console.log(
          '[Analytics Handlers] DISTRIBUTION returning',
          distribution.byStatus.length,
          'status categories'
        );
        return { success: true, data: distribution };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to get distribution:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get distribution data',
        };
      }
    }
  );

  /**
   * Export analytics data to the specified format
   *
   * Supports CSV, PDF, and JSON export formats.
   *
   * @param projectId - Project ID (required)
   * @param options - Export options (format, sections, date range, project filter)
   * @returns AnalyticsExportResult with export status and data/error
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.EXPORT,
    async (_, projectId: string, options: AnalyticsExportOptions): Promise<IPCResult<AnalyticsExportResult>> => {
      console.log('[Analytics Handlers] EXPORT called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      if (!options || !options.format) {
        return { success: false, error: 'Export format is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const result = service.exportData(projectPath, options);

        if (result.success) {
          console.log(
            '[Analytics Handlers] EXPORT successful:',
            result.bytesWritten,
            'bytes'
          );
        } else {
          console.error('[Analytics Handlers] EXPORT failed:', result.error);
        }

        return { success: true, data: result };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to export analytics:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export analytics data',
        };
      }
    }
  );

  /**
   * Calculate and store daily metrics for a specific date
   *
   * Aggregates task metrics and stores them in the task_metrics table.
   *
   * @param projectId - Project ID (required)
   * @param date - Optional date to calculate metrics for (defaults to today)
   * @returns Object with success status and metrics count
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.CALCULATE_DAILY_METRICS,
    async (
      _,
      projectId: string,
      date?: string
    ): Promise<IPCResult<{ metricsCalculated: number }>> => {
      console.log('[Analytics Handlers] CALCULATE_DAILY_METRICS called for date:', date);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const result = service.calculateDailyMetrics(projectPath, projectId, date);

        if (result.success) {
          console.log(
            '[Analytics Handlers] CALCULATE_DAILY_METRICS calculated',
            result.metricsCalculated,
            'metrics'
          );
          return { success: true, data: { metricsCalculated: result.metricsCalculated } };
        } else {
          return { success: false, error: result.error || 'Failed to calculate metrics' };
        }
      } catch (error) {
        console.error('[Analytics Handlers] Failed to calculate daily metrics:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to calculate daily metrics',
        };
      }
    }
  );

  /**
   * Get stored metrics from the task_metrics table
   *
   * @param projectId - Project ID (required)
   * @param options - Query options (date range, project filter)
   * @returns Array of TaskMetricsData objects
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.GET_STORED_METRICS,
    async (_, projectId: string, options?: AnalyticsQueryOptions): Promise<IPCResult<TaskMetricsData[]>> => {
      console.log('[Analytics Handlers] GET_STORED_METRICS called with options:', options);

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const metrics = service.getStoredMetrics(projectPath, options);
        console.log(
          '[Analytics Handlers] GET_STORED_METRICS returning',
          metrics.length,
          'metrics'
        );
        return { success: true, data: metrics };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to get stored metrics:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get stored metrics',
        };
      }
    }
  );

  /**
   * Clean up old metrics data
   *
   * Removes metrics older than the specified number of days.
   *
   * @param projectId - Project ID (required)
   * @param daysToKeep - Number of days of metrics to keep (default: 365)
   * @returns Number of rows deleted
   */
  ipcMain.handle(
    ANALYTICS_CHANNELS.CLEANUP_OLD_METRICS,
    async (_, projectId: string, daysToKeep: number = 365): Promise<IPCResult<{ deletedCount: number }>> => {
      console.log('[Analytics Handlers] CLEANUP_OLD_METRICS called, keeping', daysToKeep, 'days');

      if (!projectId) {
        return { success: false, error: 'Project ID is required' };
      }

      const projectPath = getProjectPath(projectId);
      if (!projectPath) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = getAnalyticsService();
        const deletedCount = service.cleanupOldMetrics(projectPath, daysToKeep);
        console.log('[Analytics Handlers] CLEANUP_OLD_METRICS deleted', deletedCount, 'rows');
        return { success: true, data: { deletedCount } };
      } catch (error) {
        console.error('[Analytics Handlers] Failed to cleanup old metrics:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to cleanup old metrics',
        };
      }
    }
  );

  console.log('[Analytics Handlers] All analytics IPC handlers registered successfully');
}
