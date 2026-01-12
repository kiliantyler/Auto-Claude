/**
 * Analytics Service - Task Metrics and Reporting
 * ===============================================
 *
 * Provides analytics and reporting methods for task management dashboard.
 * Queries the task_metrics table and calculates real-time metrics from tasks.
 *
 * Key Features:
 * - Overview metrics (totals, rates, velocities)
 * - Trend data for time-series charts
 * - Distribution data for pie/bar charts
 * - Daily metrics aggregation and storage
 * - Date range filtering and project filtering
 * - Feature flag support (ENABLE_ANALYTICS)
 *
 * Usage:
 * ```typescript
 * const service = getAnalyticsService();
 *
 * // Get overview metrics
 * const overview = service.getOverview({ startDate: '2025-01-01', endDate: '2025-01-31' });
 *
 * // Get trend data for charts
 * const trends = service.getTrends({ period: 'week', startDate: '2025-01-01' });
 *
 * // Get distribution data for pie charts
 * const distribution = service.getDistribution({ projectId: 'project-123' });
 * ```
 */

import type {
  AnalyticsOverview,
  TrendData,
  TrendDataPoint,
  DistributionData,
  DistributionDataPoint,
  AnalyticsQueryOptions,
  DatabaseMetricsRow,
  AnalyticsPeriod,
} from '../shared/types';
import { getDatabaseConnection } from './database';

/**
 * Analytics Service
 * Handles task analytics and reporting from SQLite database
 */
export class AnalyticsService {
  private readonly ENABLE_ANALYTICS: boolean;

  constructor() {
    // Enable analytics by default
    // Set ENABLE_ANALYTICS=false to disable analytics features
    this.ENABLE_ANALYTICS = process.env.ENABLE_ANALYTICS !== 'false';
    console.log(`[AnalyticsService] Analytics feature: ${this.ENABLE_ANALYTICS ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Check if analytics feature is enabled
   *
   * @returns true if analytics feature is enabled
   */
  isEnabled(): boolean {
    return this.ENABLE_ANALYTICS;
  }

  /**
   * Get overview metrics for a date range
   *
   * Calculates summary statistics including totals, rates, and velocities.
   *
   * @param options - Query options (date range, project filter)
   * @returns AnalyticsOverview with aggregated metrics
   */
  getOverview(options?: AnalyticsQueryOptions): AnalyticsOverview {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyOverview();
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Calculate date range
      const { startDate, endDate } = this.getDateRange(options);
      const daysInPeriod = this.calculateDaysInPeriod(startDate, endDate);

      // Build WHERE clause for filtering
      const { whereClause, params } = this.buildTaskWhereClause(options);

      // Get task counts by status
      const countsQuery = `
        SELECT
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed_tasks,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tasks,
          SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) as backlog_tasks,
          SUM(CASE WHEN status = 'ai_review' OR status = 'human_review' THEN 1 ELSE 0 END) as blocked_tasks
        FROM tasks
        ${whereClause}
      `;
      const countsStmt = db.prepare(countsQuery);
      const counts = countsStmt.get(...params) as {
        total_tasks: number;
        completed_tasks: number;
        in_progress_tasks: number;
        backlog_tasks: number;
        blocked_tasks: number;
      };

      // Get tasks completed in the period (for velocity calculation)
      const completedInPeriodQuery = `
        SELECT COUNT(*) as count
        FROM tasks
        WHERE status = 'done'
          AND updated_at >= ?
          AND updated_at <= ?
          ${options?.projectId ? 'AND project_id = ?' : ''}
      `;
      const completedParams: unknown[] = [startDate, endDate];
      if (options?.projectId) {
        completedParams.push(options.projectId);
      }
      const completedStmt = db.prepare(completedInPeriodQuery);
      const completedResult = completedStmt.get(...completedParams) as { count: number };
      const completedInPeriod = completedResult.count;

      // Calculate metrics
      const totalTasks = counts.total_tasks || 0;
      const completedTasks = counts.completed_tasks || 0;
      const inProgressTasks = counts.in_progress_tasks || 0;
      const backlogTasks = counts.backlog_tasks || 0;
      const blockedTasks = counts.blocked_tasks || 0;

      const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      const velocityPerDay = daysInPeriod > 0 ? Math.round((completedInPeriod / daysInPeriod) * 100) / 100 : 0;
      const velocityPerWeek = velocityPerDay * 7;

      // Get average completion time from task_metrics if available
      const avgTimeQuery = `
        SELECT AVG(avg_completion_time_hours) as avg_time
        FROM task_metrics
        WHERE metric_date >= ? AND metric_date <= ?
          ${options?.projectId ? 'AND project_id = ?' : ''}
      `;
      const avgTimeParams: unknown[] = [startDate, endDate];
      if (options?.projectId) {
        avgTimeParams.push(options.projectId);
      }
      const avgTimeStmt = db.prepare(avgTimeQuery);
      const avgTimeResult = avgTimeStmt.get(...avgTimeParams) as { avg_time: number | null };

      // Get previous period data for comparison if requested
      let completionRateChange: number | undefined;
      let velocityChange: number | undefined;
      let taskCountChange: number | undefined;

      if (options?.compareToPrevious) {
        const previousPeriodData = this.getPreviousPeriodData(options, daysInPeriod);
        if (previousPeriodData) {
          completionRateChange = completionRate - previousPeriodData.completionRate;
          velocityChange = velocityPerDay - previousPeriodData.velocityPerDay;
          taskCountChange = totalTasks - previousPeriodData.totalTasks;
        }
      }

      return {
        totalTasks,
        completedTasks,
        inProgressTasks,
        backlogTasks,
        blockedTasks,
        completionRate,
        velocityPerDay,
        velocityPerWeek,
        avgCompletionTimeHours: avgTimeResult.avg_time,
        avgCycleTimeHours: null, // Would require more detailed tracking
        avgLeadTimeHours: null, // Would require more detailed tracking
        periodStart: startDate,
        periodEnd: endDate,
        daysInPeriod,
        completionRateChange,
        velocityChange,
        taskCountChange,
      };
    } catch (error) {
      console.error('[AnalyticsService] Failed to get overview:', error);
      return this.getEmptyOverview();
    }
  }

  /**
   * Get trend data for time-series charts
   *
   * Returns data points for each day/week/month in the specified period.
   *
   * @param options - Query options (period, date range, project filter)
   * @returns TrendData with multiple data series
   */
  getTrends(options?: AnalyticsQueryOptions): TrendData {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyTrends();
    }

    try {
      const db = getDatabaseConnection().getConnection();

      const { startDate, endDate } = this.getDateRange(options);
      const period = options?.period || 'day';

      // Get metrics data from task_metrics table
      const metricsQuery = `
        SELECT *
        FROM task_metrics
        WHERE metric_date >= ? AND metric_date <= ?
          ${options?.projectId ? 'AND project_id = ?' : ''}
        ORDER BY metric_date ASC
      `;
      const metricsParams: unknown[] = [startDate, endDate];
      if (options?.projectId) {
        metricsParams.push(options.projectId);
      }
      const metricsStmt = db.prepare(metricsQuery);
      const metricsRows = metricsStmt.all(...metricsParams) as DatabaseMetricsRow[];

      // If no pre-aggregated metrics, calculate from tasks table
      if (metricsRows.length === 0) {
        return this.calculateTrendsFromTasks(options, startDate, endDate, period);
      }

      // Convert metrics rows to trend data points
      const completedTasks: TrendDataPoint[] = [];
      const createdTasks: TrendDataPoint[] = [];
      const totalTasks: TrendDataPoint[] = [];
      const velocity: TrendDataPoint[] = [];
      const avgCompletionTime: TrendDataPoint[] = [];
      const inProgressTasks: TrendDataPoint[] = [];

      for (const row of metricsRows) {
        const date = row.metric_date;

        completedTasks.push({ date, value: row.completed_count || 0 });
        createdTasks.push({ date, value: row.created_count || 0 });
        totalTasks.push({ date, value: row.total_tasks || 0 });
        velocity.push({ date, value: row.completed_count || 0 }); // Daily velocity = completed count
        avgCompletionTime.push({ date, value: row.avg_completion_time_hours || 0 });
        inProgressTasks.push({ date, value: row.in_progress_tasks || 0 });
      }

      return {
        period,
        startDate,
        endDate,
        completedTasks,
        createdTasks,
        totalTasks,
        velocity,
        avgCompletionTime,
        inProgressTasks,
      };
    } catch (error) {
      console.error('[AnalyticsService] Failed to get trends:', error);
      return this.getEmptyTrends();
    }
  }

  /**
   * Get distribution data for pie/bar charts
   *
   * Returns task counts grouped by status, category, priority, etc.
   *
   * @param options - Query options (project filter)
   * @returns DistributionData with multiple breakdowns
   */
  getDistribution(options?: AnalyticsQueryOptions): DistributionData {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyDistribution();
    }

    try {
      const db = getDatabaseConnection().getConnection();

      // Build WHERE clause for filtering
      const { whereClause, params } = this.buildTaskWhereClause(options);

      // Get status distribution
      const statusQuery = `
        SELECT status, COUNT(*) as count
        FROM tasks
        ${whereClause}
        GROUP BY status
        ORDER BY count DESC
      `;
      const statusStmt = db.prepare(statusQuery);
      const statusRows = statusStmt.all(...params) as { status: string; count: number }[];

      // Calculate total for percentage
      const totalTasks = statusRows.reduce((sum, row) => sum + row.count, 0);

      // Convert to distribution data points with colors
      const statusColors: Record<string, string> = {
        done: '#10b981', // emerald-500
        in_progress: '#3b82f6', // blue-500
        backlog: '#f59e0b', // amber-500
        ai_review: '#8b5cf6', // violet-500
        human_review: '#ef4444', // red-500
      };

      const byStatus: DistributionDataPoint[] = statusRows.map((row) => ({
        name: this.formatStatusName(row.status),
        value: row.count,
        percentage: totalTasks > 0 ? Math.round((row.count / totalTasks) * 100) : 0,
        color: statusColors[row.status] || '#6b7280', // gray-500 fallback
      }));

      // Get project distribution if not filtering by project
      let byProject: DistributionDataPoint[] | undefined;
      if (!options?.projectId) {
        const projectQuery = `
          SELECT t.project_id, p.name as project_name, COUNT(*) as count
          FROM tasks t
          LEFT JOIN projects p ON t.project_id = p.id
          ${whereClause}
          GROUP BY t.project_id
          ORDER BY count DESC
          LIMIT 10
        `;
        const projectStmt = db.prepare(projectQuery);
        const projectRows = projectStmt.all(...params) as { project_id: string; project_name: string | null; count: number }[];

        byProject = projectRows.map((row) => ({
          name: row.project_name || row.project_id,
          value: row.count,
          percentage: totalTasks > 0 ? Math.round((row.count / totalTasks) * 100) : 0,
        }));
      }

      return {
        byStatus,
        byProject,
        totalTasks,
      };
    } catch (error) {
      console.error('[AnalyticsService] Failed to get distribution:', error);
      return this.getEmptyDistribution();
    }
  }

  /**
   * Get the date range for a query, using defaults if not specified
   */
  private getDateRange(options?: AnalyticsQueryOptions): { startDate: string; endDate: string } {
    if (options?.startDate && options?.endDate) {
      return { startDate: options.startDate, endDate: options.endDate };
    }

    // Default to last 30 days
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);

    return {
      startDate: options?.startDate || start.toISOString().split('T')[0],
      endDate: options?.endDate || end.toISOString().split('T')[0],
    };
  }

  /**
   * Calculate the number of days in a period
   */
  private calculateDaysInPeriod(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include both endpoints
  }

  /**
   * Build WHERE clause for task queries
   */
  private buildTaskWhereClause(options?: AnalyticsQueryOptions): { whereClause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.projectId) {
      conditions.push('project_id = ?');
      params.push(options.projectId);
    }

    if (!options?.includeArchived) {
      // Exclude archived tasks (those with archivedAt in metadata_json)
      conditions.push("(metadata_json IS NULL OR metadata_json NOT LIKE '%\"archivedAt\"%')");
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { whereClause, params };
  }

  /**
   * Get previous period data for comparison
   */
  private getPreviousPeriodData(
    options: AnalyticsQueryOptions,
    daysInPeriod: number
  ): { completionRate: number; velocityPerDay: number; totalTasks: number } | null {
    try {
      const { startDate } = this.getDateRange(options);
      const start = new Date(startDate);

      // Calculate previous period dates
      const prevEnd = new Date(start);
      prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setDate(prevStart.getDate() - daysInPeriod + 1);

      const prevOptions: AnalyticsQueryOptions = {
        ...options,
        startDate: prevStart.toISOString().split('T')[0],
        endDate: prevEnd.toISOString().split('T')[0],
        compareToPrevious: false, // Prevent infinite recursion
      };

      const prevOverview = this.getOverview(prevOptions);
      return {
        completionRate: prevOverview.completionRate,
        velocityPerDay: prevOverview.velocityPerDay,
        totalTasks: prevOverview.totalTasks,
      };
    } catch {
      return null;
    }
  }

  /**
   * Calculate trends directly from tasks table when no metrics data exists
   */
  private calculateTrendsFromTasks(
    options: AnalyticsQueryOptions | undefined,
    startDate: string,
    endDate: string,
    period: AnalyticsPeriod
  ): TrendData {
    try {
      const db = getDatabaseConnection().getConnection();

      // Generate date range
      const dates = this.generateDateRange(startDate, endDate);
      const completedTasks: TrendDataPoint[] = [];
      const createdTasks: TrendDataPoint[] = [];
      const totalTasks: TrendDataPoint[] = [];
      const velocity: TrendDataPoint[] = [];
      const avgCompletionTime: TrendDataPoint[] = [];

      const projectFilter = options?.projectId ? 'AND project_id = ?' : '';
      const projectParam = options?.projectId ? [options.projectId] : [];

      for (const date of dates) {
        const nextDate = new Date(date);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateStr = nextDate.toISOString().split('T')[0];

        // Count tasks created on this date
        const createdQuery = `
          SELECT COUNT(*) as count FROM tasks
          WHERE date(created_at) = ? ${projectFilter}
        `;
        const createdStmt = db.prepare(createdQuery);
        const createdResult = createdStmt.get(date, ...projectParam) as { count: number };

        // Count tasks completed on this date (status changed to done)
        // This is an approximation since we don't track completion date directly
        const completedQuery = `
          SELECT COUNT(*) as count FROM tasks
          WHERE status = 'done' AND date(updated_at) = ? ${projectFilter}
        `;
        const completedStmt = db.prepare(completedQuery);
        const completedResult = completedStmt.get(date, ...projectParam) as { count: number };

        // Count total tasks as of end of this date
        const totalQuery = `
          SELECT COUNT(*) as count FROM tasks
          WHERE date(created_at) <= ? ${projectFilter}
        `;
        const totalStmt = db.prepare(totalQuery);
        const totalResult = totalStmt.get(date, ...projectParam) as { count: number };

        completedTasks.push({ date, value: completedResult.count });
        createdTasks.push({ date, value: createdResult.count });
        totalTasks.push({ date, value: totalResult.count });
        velocity.push({ date, value: completedResult.count });
        avgCompletionTime.push({ date, value: 0 }); // Not available without metrics
      }

      return {
        period,
        startDate,
        endDate,
        completedTasks,
        createdTasks,
        totalTasks,
        velocity,
        avgCompletionTime,
      };
    } catch (error) {
      console.error('[AnalyticsService] Failed to calculate trends from tasks:', error);
      return this.getEmptyTrends();
    }
  }

  /**
   * Generate array of dates between start and end
   */
  private generateDateRange(startDate: string, endDate: string): string[] {
    const dates: string[] = [];
    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  /**
   * Format status name for display
   */
  private formatStatusName(status: string): string {
    const statusNames: Record<string, string> = {
      done: 'Done',
      in_progress: 'In Progress',
      backlog: 'Backlog',
      ai_review: 'AI Review',
      human_review: 'Human Review',
    };
    return statusNames[status] || status;
  }

  /**
   * Get empty overview for disabled state or errors
   */
  private getEmptyOverview(): AnalyticsOverview {
    const now = new Date().toISOString().split('T')[0];
    return {
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      backlogTasks: 0,
      blockedTasks: 0,
      completionRate: 0,
      velocityPerDay: 0,
      velocityPerWeek: 0,
      avgCompletionTimeHours: null,
      avgCycleTimeHours: null,
      avgLeadTimeHours: null,
      periodStart: now,
      periodEnd: now,
      daysInPeriod: 0,
    };
  }

  /**
   * Get empty trends for disabled state or errors
   */
  private getEmptyTrends(): TrendData {
    const now = new Date().toISOString().split('T')[0];
    return {
      period: 'day',
      startDate: now,
      endDate: now,
      completedTasks: [],
      createdTasks: [],
      totalTasks: [],
      velocity: [],
      avgCompletionTime: [],
    };
  }

  /**
   * Get empty distribution for disabled state or errors
   */
  private getEmptyDistribution(): DistributionData {
    return {
      byStatus: [],
      totalTasks: 0,
    };
  }
}

// Singleton instance
let _instance: AnalyticsService | null = null;

/**
 * Get the singleton AnalyticsService instance
 *
 * @returns AnalyticsService instance
 */
export function getAnalyticsService(): AnalyticsService {
  if (!_instance) {
    _instance = new AnalyticsService();
  }
  return _instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetAnalyticsService(): void {
  _instance = null;
}
