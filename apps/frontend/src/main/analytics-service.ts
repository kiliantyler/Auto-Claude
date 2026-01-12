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
  TaskMetricsData,
  AnalyticsExportOptions,
  AnalyticsExportResult,
} from '../shared/types';
import { getProjectDatabase } from './database';
import Papa from 'papaparse';
import { jsPDF } from 'jspdf';

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
   * @param projectPath - Path to the project (required)
   * @param options - Query options (date range, project filter)
   * @returns AnalyticsOverview with aggregated metrics
   */
  getOverview(projectPath: string, options?: AnalyticsQueryOptions): AnalyticsOverview {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyOverview();
    }

    if (!projectPath) {
      console.warn('[AnalyticsService] getOverview called without projectPath');
      return this.getEmptyOverview();
    }

    try {
      const db = getProjectDatabase(projectPath);

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
        const previousPeriodData = this.getPreviousPeriodData(projectPath, options, daysInPeriod);
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
   * @param projectPath - Path to the project (required)
   * @param options - Query options (period, date range, project filter)
   * @returns TrendData with multiple data series
   */
  getTrends(projectPath: string, options?: AnalyticsQueryOptions): TrendData {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyTrends();
    }

    if (!projectPath) {
      console.warn('[AnalyticsService] getTrends called without projectPath');
      return this.getEmptyTrends();
    }

    try {
      const db = getProjectDatabase(projectPath);

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
        return this.calculateTrendsFromTasks(projectPath, options, startDate, endDate, period);
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
   * @param projectPath - Path to the project (required)
   * @param options - Query options (project filter)
   * @returns DistributionData with multiple breakdowns
   */
  getDistribution(projectPath: string, options?: AnalyticsQueryOptions): DistributionData {
    if (!this.ENABLE_ANALYTICS) {
      return this.getEmptyDistribution();
    }

    if (!projectPath) {
      console.warn('[AnalyticsService] getDistribution called without projectPath');
      return this.getEmptyDistribution();
    }

    try {
      const db = getProjectDatabase(projectPath);

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

      // Note: Project distribution is no longer available since projects table
      // is in global DB and tasks are in project-local DB. Each project has its
      // own database, so cross-project distribution must be calculated at a higher level.

      return {
        byStatus,
        byProject: undefined,
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
    projectPath: string,
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

      const prevOverview = this.getOverview(projectPath, prevOptions);
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
    projectPath: string,
    options: AnalyticsQueryOptions | undefined,
    startDate: string,
    endDate: string,
    period: AnalyticsPeriod
  ): TrendData {
    try {
      const db = getProjectDatabase(projectPath);

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

  /**
   * Calculate and store daily metrics for a specific date
   *
   * Aggregates task metrics for the given date (or today) and stores them
   * in the task_metrics table. Uses UPSERT to update existing entries.
   *
   * @param projectPath - Path to the project (required)
   * @param projectId - Project ID for storing metrics
   * @param date - The date to calculate metrics for (ISO format: YYYY-MM-DD, defaults to today)
   * @returns Object with success status and metrics count
   */
  calculateDailyMetrics(
    projectPath: string,
    projectId: string,
    date?: string
  ): { success: boolean; metricsCalculated: number; error?: string } {
    if (!this.ENABLE_ANALYTICS) {
      return { success: false, metricsCalculated: 0, error: 'Analytics feature is disabled' };
    }

    if (!projectPath || !projectId) {
      return { success: false, metricsCalculated: 0, error: 'Project path and ID are required' };
    }

    try {
      const db = getProjectDatabase(projectPath);

      // Use provided date or default to today
      const metricDate = date || new Date().toISOString().split('T')[0];

      // Calculate task counts by status
      const countsQuery = db.prepare(`
        SELECT
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed_tasks,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tasks,
          SUM(CASE WHEN status = 'ai_review' OR status = 'human_review' THEN 1 ELSE 0 END) as blocked_tasks
        FROM tasks
        WHERE (metadata_json IS NULL OR metadata_json NOT LIKE '%"archivedAt"%')
      `);
      const counts = countsQuery.get() as {
        total_tasks: number;
        completed_tasks: number;
        in_progress_tasks: number;
        blocked_tasks: number;
      };

      // Count tasks created on this date
      const createdQuery = db.prepare(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE date(created_at) = ?
      `);
      const createdResult = createdQuery.get(metricDate) as { count: number };

      // Count tasks completed on this date (status changed to 'done' on this date)
      // We check the task_history table for status_changed events to 'done'
      const completedQuery = db.prepare(`
        SELECT COUNT(DISTINCT task_id) as count
        FROM task_history
        WHERE date(timestamp) = ?
          AND action = 'status_changed'
          AND json_extract(new_value, '$.status') = 'done'
      `);
      const completedResult = completedQuery.get(metricDate) as { count: number };

      // Calculate average completion time for tasks completed on this date
      // This is the time between task creation and completion
      const avgTimeQuery = db.prepare(`
        SELECT AVG(
          (julianday(h.timestamp) - julianday(t.created_at)) * 24
        ) as avg_hours
        FROM task_history h
        JOIN tasks t ON h.task_id = t.id
        WHERE date(h.timestamp) = ?
          AND h.action = 'status_changed'
          AND json_extract(h.new_value, '$.status') = 'done'
      `);
      const avgTimeResult = avgTimeQuery.get(metricDate) as { avg_hours: number | null };

      // Round average completion time to 2 decimal places
      const avgCompletionTimeHours =
        avgTimeResult.avg_hours !== null ? Math.round(avgTimeResult.avg_hours * 100) / 100 : null;

      // Upsert metrics into task_metrics table
      const upsertQuery = db.prepare(`
        INSERT INTO task_metrics (
          project_id,
          metric_date,
          total_tasks,
          completed_tasks,
          in_progress_tasks,
          blocked_tasks,
          avg_completion_time_hours,
          created_count,
          completed_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, metric_date) DO UPDATE SET
          total_tasks = excluded.total_tasks,
          completed_tasks = excluded.completed_tasks,
          in_progress_tasks = excluded.in_progress_tasks,
          blocked_tasks = excluded.blocked_tasks,
          avg_completion_time_hours = excluded.avg_completion_time_hours,
          created_count = excluded.created_count,
          completed_count = excluded.completed_count
      `);

      upsertQuery.run(
        projectId,
        metricDate,
        counts.total_tasks || 0,
        counts.completed_tasks || 0,
        counts.in_progress_tasks || 0,
        counts.blocked_tasks || 0,
        avgCompletionTimeHours,
        createdResult.count || 0,
        completedResult.count || 0
      );

      return { success: true, metricsCalculated: 1 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error calculating daily metrics';
      console.error('[AnalyticsService] Failed to calculate daily metrics:', error);
      return { success: false, metricsCalculated: 0, error: errorMessage };
    }
  }

  /**
   * Calculate and store metrics for a date range
   *
   * Useful for backfilling historical metrics or recalculating after data changes.
   *
   * @param projectPath - Path to the project (required)
   * @param projectId - Project ID for storing metrics (required)
   * @param startDate - Start date (ISO format: YYYY-MM-DD)
   * @param endDate - End date (ISO format: YYYY-MM-DD)
   * @returns Object with success status and total metrics count
   */
  calculateMetricsForRange(
    projectPath: string,
    projectId: string,
    startDate: string,
    endDate: string
  ): { success: boolean; totalMetrics: number; errors: string[] } {
    if (!this.ENABLE_ANALYTICS) {
      return { success: false, totalMetrics: 0, errors: ['Analytics feature is disabled'] };
    }

    if (!projectPath || !projectId) {
      return { success: false, totalMetrics: 0, errors: ['Project path and ID are required'] };
    }

    const errors: string[] = [];
    let totalMetrics = 0;

    try {
      // Generate date range
      const dates = this.generateDateRange(startDate, endDate);

      for (const date of dates) {
        const result = this.calculateDailyMetrics(projectPath, projectId, date);
        if (result.success) {
          totalMetrics += result.metricsCalculated;
        } else if (result.error) {
          errors.push(`${date}: ${result.error}`);
        }
      }

      return { success: errors.length === 0, totalMetrics, errors };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errors.push(errorMessage);
      return { success: false, totalMetrics, errors };
    }
  }

  /**
   * Get stored metrics from the task_metrics table
   *
   * @param projectPath - Path to the project (required)
   * @param options - Query options (date range, project filter)
   * @returns Array of TaskMetricsData objects
   */
  getStoredMetrics(projectPath: string, options?: AnalyticsQueryOptions): TaskMetricsData[] {
    if (!this.ENABLE_ANALYTICS) {
      return [];
    }

    if (!projectPath) {
      console.warn('[AnalyticsService] getStoredMetrics called without projectPath');
      return [];
    }

    try {
      const db = getProjectDatabase(projectPath);
      const { startDate, endDate } = this.getDateRange(options);

      let query = `
        SELECT *
        FROM task_metrics
        WHERE metric_date >= ? AND metric_date <= ?
      `;
      const params: unknown[] = [startDate, endDate];

      if (options?.projectId) {
        query += ' AND project_id = ?';
        params.push(options.projectId);
      }

      query += ' ORDER BY metric_date ASC, project_id ASC';

      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as DatabaseMetricsRow[];

      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        metricDate: row.metric_date,
        totalTasks: row.total_tasks || 0,
        completedTasks: row.completed_tasks || 0,
        inProgressTasks: row.in_progress_tasks || 0,
        blockedTasks: row.blocked_tasks || 0,
        avgCompletionTimeHours: row.avg_completion_time_hours,
        createdCount: row.created_count || 0,
        completedCount: row.completed_count || 0,
      }));
    } catch (error) {
      console.error('[AnalyticsService] Failed to get stored metrics:', error);
      return [];
    }
  }

  /**
   * Clean up old metrics data
   *
   * @param projectPath - Path to the project (required)
   * @param daysToKeep - Number of days of metrics to keep (default: 365)
   * @returns Number of rows deleted
   */
  cleanupOldMetrics(projectPath: string, daysToKeep: number = 365): number {
    if (!this.ENABLE_ANALYTICS) {
      return 0;
    }

    if (!projectPath) {
      console.warn('[AnalyticsService] cleanupOldMetrics called without projectPath');
      return 0;
    }

    try {
      const db = getProjectDatabase(projectPath);

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

      const deleteStmt = db.prepare('DELETE FROM task_metrics WHERE metric_date < ?');
      const result = deleteStmt.run(cutoffDateStr);

      return result.changes;
    } catch (error) {
      console.error('[AnalyticsService] Failed to cleanup old metrics:', error);
      return 0;
    }
  }

  /**
   * Export analytics data to the specified format
   *
   * @param projectPath - Path to the project (required)
   * @param options - Export options (format, sections, date range, etc.)
   * @returns AnalyticsExportResult with success status and data/error
   */
  exportData(projectPath: string, options: AnalyticsExportOptions): AnalyticsExportResult {
    if (!this.ENABLE_ANALYTICS) {
      return { success: false, error: 'Analytics feature is disabled' };
    }

    if (!projectPath) {
      return { success: false, error: 'Project path is required' };
    }

    try {
      const queryOptions: AnalyticsQueryOptions = {
        projectId: options.projectId,
        startDate: options.startDate,
        endDate: options.endDate,
      };

      switch (options.format) {
        case 'csv':
          return this.exportToCSV(projectPath, queryOptions, options);
        case 'pdf':
          return this.exportToPDF(projectPath, queryOptions, options);
        case 'json':
          return this.exportToJSON(projectPath, queryOptions, options);
        default:
          return { success: false, error: `Unsupported export format: ${options.format}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown export error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Export analytics data to CSV format using papaparse
   *
   * @param projectPath - Path to the project
   * @param queryOptions - Query options for fetching data
   * @param exportOptions - Export options (sections, filename, etc.)
   * @returns AnalyticsExportResult with CSV data
   */
  private exportToCSV(
    projectPath: string,
    queryOptions: AnalyticsQueryOptions,
    exportOptions: AnalyticsExportOptions
  ): AnalyticsExportResult {
    try {
      const sections = exportOptions.sections || ['overview', 'trends', 'distribution'];
      const csvSections: string[] = [];

      // Export overview section
      if (sections.includes('overview')) {
        const overview = this.getOverview(projectPath, queryOptions);
        const overviewData = [
          { Metric: 'Total Tasks', Value: overview.totalTasks },
          { Metric: 'Completed Tasks', Value: overview.completedTasks },
          { Metric: 'In Progress Tasks', Value: overview.inProgressTasks },
          { Metric: 'Backlog Tasks', Value: overview.backlogTasks },
          { Metric: 'Blocked Tasks', Value: overview.blockedTasks },
          { Metric: 'Completion Rate (%)', Value: overview.completionRate },
          { Metric: 'Velocity Per Day', Value: overview.velocityPerDay },
          { Metric: 'Velocity Per Week', Value: overview.velocityPerWeek },
          { Metric: 'Avg Completion Time (Hours)', Value: overview.avgCompletionTimeHours ?? 'N/A' },
          { Metric: 'Period Start', Value: overview.periodStart },
          { Metric: 'Period End', Value: overview.periodEnd },
          { Metric: 'Days In Period', Value: overview.daysInPeriod },
        ];

        csvSections.push('# Overview Metrics');
        csvSections.push(Papa.unparse(overviewData));
      }

      // Export trends section
      if (sections.includes('trends')) {
        const trends = this.getTrends(projectPath, queryOptions);
        const trendData = trends.completedTasks.map((point, index) => ({
          Date: point.date,
          'Completed Tasks': point.value,
          'Created Tasks': trends.createdTasks[index]?.value ?? 0,
          'Total Tasks': trends.totalTasks[index]?.value ?? 0,
          Velocity: trends.velocity[index]?.value ?? 0,
          'Avg Completion Time (Hours)': trends.avgCompletionTime[index]?.value ?? 0,
        }));

        if (trendData.length > 0) {
          csvSections.push('');
          csvSections.push('# Trend Data');
          csvSections.push(Papa.unparse(trendData));
        }
      }

      // Export distribution section
      if (sections.includes('distribution')) {
        const distribution = this.getDistribution(projectPath, queryOptions);
        const distributionData = distribution.byStatus.map((item) => ({
          Status: item.name,
          Count: item.value,
          'Percentage (%)': item.percentage,
        }));

        if (distributionData.length > 0) {
          csvSections.push('');
          csvSections.push('# Status Distribution');
          csvSections.push(Papa.unparse(distributionData));
        }

        // Export project distribution if available
        if (distribution.byProject && distribution.byProject.length > 0) {
          const projectData = distribution.byProject.map((item) => ({
            Project: item.name,
            Count: item.value,
            'Percentage (%)': item.percentage,
          }));

          csvSections.push('');
          csvSections.push('# Project Distribution');
          csvSections.push(Papa.unparse(projectData));
        }
      }

      // Export velocity section
      if (sections.includes('velocity')) {
        const trends = this.getTrends(projectPath, queryOptions);
        const velocityData = trends.velocity.map((point, index) => ({
          Date: point.date,
          Completed: point.value,
          Created: trends.createdTasks[index]?.value ?? 0,
          'Net Change': point.value - (trends.createdTasks[index]?.value ?? 0),
        }));

        if (velocityData.length > 0) {
          csvSections.push('');
          csvSections.push('# Velocity Data');
          csvSections.push(Papa.unparse(velocityData));
        }
      }

      const csvContent = csvSections.join('\n');
      const bytesWritten = Buffer.byteLength(csvContent, 'utf8');

      return {
        success: true,
        data: csvContent,
        bytesWritten,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'CSV export failed';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Export analytics data to PDF format using jspdf
   *
   * @param projectPath - Path to the project
   * @param queryOptions - Query options for fetching data
   * @param exportOptions - Export options (sections, filename, etc.)
   * @returns AnalyticsExportResult with base64 PDF data
   */
  private exportToPDF(
    projectPath: string,
    queryOptions: AnalyticsQueryOptions,
    exportOptions: AnalyticsExportOptions
  ): AnalyticsExportResult {
    try {
      const sections = exportOptions.sections || ['overview', 'trends', 'distribution'];
      const doc = new jsPDF();

      let yPosition = 20;
      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 20;
      const contentWidth = pageWidth - margin * 2;

      // Helper function to check if we need a new page
      const checkNewPage = (requiredSpace: number): void => {
        if (yPosition + requiredSpace > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          yPosition = 20;
        }
      };

      // Title
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Analytics Report', margin, yPosition);
      yPosition += 10;

      // Subtitle with date range
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      const { startDate, endDate } = this.getDateRange(queryOptions);
      doc.text(`Period: ${startDate} to ${endDate}`, margin, yPosition);
      yPosition += 5;
      doc.text(`Generated: ${new Date().toISOString().split('T')[0]}`, margin, yPosition);
      yPosition += 15;

      // Export overview section
      if (sections.includes('overview')) {
        checkNewPage(60);

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Overview Metrics', margin, yPosition);
        yPosition += 8;

        const overview = this.getOverview(projectPath, queryOptions);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');

        const overviewMetrics = [
          ['Total Tasks', overview.totalTasks.toString()],
          ['Completed Tasks', overview.completedTasks.toString()],
          ['In Progress Tasks', overview.inProgressTasks.toString()],
          ['Backlog Tasks', overview.backlogTasks.toString()],
          ['Blocked Tasks', overview.blockedTasks.toString()],
          ['Completion Rate', `${overview.completionRate}%`],
          ['Velocity Per Day', overview.velocityPerDay.toFixed(2)],
          ['Velocity Per Week', overview.velocityPerWeek.toFixed(2)],
          ['Avg Completion Time', overview.avgCompletionTimeHours !== null ? `${overview.avgCompletionTimeHours.toFixed(1)} hours` : 'N/A'],
        ];

        // Draw metrics in two columns
        const colWidth = contentWidth / 2;
        for (let i = 0; i < overviewMetrics.length; i++) {
          const [label, value] = overviewMetrics[i];
          const col = i % 2;
          const x = margin + col * colWidth;

          if (col === 0 && i > 0) {
            yPosition += 6;
          }

          doc.setFont('helvetica', 'normal');
          doc.text(`${label}:`, x, yPosition);
          doc.setFont('helvetica', 'bold');
          doc.text(value, x + 60, yPosition);
        }

        yPosition += 15;
      }

      // Export distribution section
      if (sections.includes('distribution')) {
        checkNewPage(50);

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Status Distribution', margin, yPosition);
        yPosition += 8;

        const distribution = this.getDistribution(projectPath, queryOptions);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');

        // Table header
        doc.setFont('helvetica', 'bold');
        doc.text('Status', margin, yPosition);
        doc.text('Count', margin + 60, yPosition);
        doc.text('Percentage', margin + 100, yPosition);
        yPosition += 6;

        // Table rows
        doc.setFont('helvetica', 'normal');
        for (const item of distribution.byStatus) {
          checkNewPage(8);
          doc.text(item.name, margin, yPosition);
          doc.text(item.value.toString(), margin + 60, yPosition);
          doc.text(`${item.percentage}%`, margin + 100, yPosition);
          yPosition += 6;
        }

        yPosition += 10;
      }

      // Export trends section (simplified table format)
      if (sections.includes('trends')) {
        checkNewPage(40);

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Trend Summary', margin, yPosition);
        yPosition += 8;

        const trends = this.getTrends(projectPath, queryOptions);
        doc.setFontSize(10);
        doc.setFont('helvetica', 'normal');

        // Calculate summary statistics
        const totalCompleted = trends.completedTasks.reduce((sum, p) => sum + p.value, 0);
        const totalCreated = trends.createdTasks.reduce((sum, p) => sum + p.value, 0);
        const avgVelocity = trends.velocity.length > 0
          ? trends.velocity.reduce((sum, p) => sum + p.value, 0) / trends.velocity.length
          : 0;

        const trendSummary = [
          ['Data Points', trends.completedTasks.length.toString()],
          ['Total Completed', totalCompleted.toString()],
          ['Total Created', totalCreated.toString()],
          ['Net Change', (totalCompleted - totalCreated).toString()],
          ['Average Velocity', avgVelocity.toFixed(2)],
        ];

        for (const [label, value] of trendSummary) {
          doc.setFont('helvetica', 'normal');
          doc.text(`${label}:`, margin, yPosition);
          doc.setFont('helvetica', 'bold');
          doc.text(value, margin + 60, yPosition);
          yPosition += 6;
        }

        yPosition += 10;
      }

      // Export velocity section
      if (sections.includes('velocity')) {
        checkNewPage(50);

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Velocity Details', margin, yPosition);
        yPosition += 8;

        const trends = this.getTrends(projectPath, queryOptions);
        doc.setFontSize(9);

        // Table header
        doc.setFont('helvetica', 'bold');
        doc.text('Date', margin, yPosition);
        doc.text('Completed', margin + 35, yPosition);
        doc.text('Created', margin + 65, yPosition);
        doc.text('Net', margin + 90, yPosition);
        yPosition += 5;

        // Draw line under header
        doc.setDrawColor(200);
        doc.line(margin, yPosition, margin + 100, yPosition);
        yPosition += 3;

        // Show last 10 entries to keep PDF compact
        doc.setFont('helvetica', 'normal');
        const recentVelocity = trends.velocity.slice(-10);
        for (let i = 0; i < recentVelocity.length; i++) {
          checkNewPage(6);
          const point = recentVelocity[i];
          const created = trends.createdTasks[trends.velocity.length - 10 + i]?.value ?? 0;
          const net = point.value - created;

          doc.text(point.date, margin, yPosition);
          doc.text(point.value.toString(), margin + 35, yPosition);
          doc.text(created.toString(), margin + 65, yPosition);
          doc.text(net.toString(), margin + 90, yPosition);
          yPosition += 5;
        }
      }

      // Generate PDF as base64 string
      const pdfOutput = doc.output('datauristring');
      const bytesWritten = Math.ceil((pdfOutput.length * 3) / 4); // Approximate byte size from base64

      return {
        success: true,
        data: pdfOutput,
        bytesWritten,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'PDF export failed';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Export analytics data to JSON format
   *
   * @param projectPath - Path to the project
   * @param queryOptions - Query options for fetching data
   * @param exportOptions - Export options (sections, filename, etc.)
   * @returns AnalyticsExportResult with JSON data
   */
  private exportToJSON(
    projectPath: string,
    queryOptions: AnalyticsQueryOptions,
    exportOptions: AnalyticsExportOptions
  ): AnalyticsExportResult {
    try {
      const sections = exportOptions.sections || ['overview', 'trends', 'distribution', 'velocity'];
      const exportData: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        period: {
          start: queryOptions.startDate,
          end: queryOptions.endDate,
        },
      };

      if (sections.includes('overview')) {
        exportData.overview = this.getOverview(projectPath, queryOptions);
      }

      if (sections.includes('trends')) {
        exportData.trends = this.getTrends(projectPath, queryOptions);
      }

      if (sections.includes('distribution')) {
        exportData.distribution = this.getDistribution(projectPath, queryOptions);
      }

      if (sections.includes('velocity')) {
        // Velocity is derived from trends
        const trends = this.getTrends(projectPath, queryOptions);
        exportData.velocity = {
          period: trends.period,
          dataPoints: trends.velocity.map((point, index) => ({
            date: point.date,
            completed: point.value,
            created: trends.createdTasks[index]?.value ?? 0,
            netChange: point.value - (trends.createdTasks[index]?.value ?? 0),
          })),
          totalCompleted: trends.completedTasks.reduce((sum, p) => sum + p.value, 0),
          totalCreated: trends.createdTasks.reduce((sum, p) => sum + p.value, 0),
          averageVelocity: trends.velocity.length > 0
            ? trends.velocity.reduce((sum, p) => sum + p.value, 0) / trends.velocity.length
            : 0,
        };
      }

      const jsonContent = JSON.stringify(exportData, null, 2);
      const bytesWritten = Buffer.byteLength(jsonContent, 'utf8');

      return {
        success: true,
        data: jsonContent,
        bytesWritten,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'JSON export failed';
      return { success: false, error: errorMessage };
    }
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
