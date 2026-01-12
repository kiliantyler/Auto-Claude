import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  Download,
  RefreshCw,
  BarChart3,
  TrendingUp,
  PieChart,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { cn } from '../../lib/utils';
import type {
  AnalyticsPeriod,
  AnalyticsOverview,
  TrendData,
  DistributionData,
  VelocityData,
  ExportFormat
} from '../../../shared/types';
import { getDefaultDateRange, DEFAULT_ANALYTICS_CONFIG } from '../../../shared/types/analytics';

/**
 * Props for the Analytics component
 */
interface AnalyticsProps {
  projectId?: string;
  className?: string;
}

/**
 * Period options for the date range selector
 */
const PERIOD_OPTIONS: { value: AnalyticsPeriod; label: string }[] = [
  { value: 'day', label: 'Last 24 Hours' },
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'Last 30 Days' },
  { value: 'quarter', label: 'Last 3 Months' },
  { value: 'year', label: 'Last 12 Months' },
];

/**
 * Analytics Dashboard main page component
 * Displays task metrics, trends, distribution, and velocity charts
 * with a date range selector and export functionality.
 *
 * Phase 4D - Analytics & Reporting
 */
export function Analytics({ projectId, className }: AnalyticsProps) {
  const { t } = useTranslation(['common']);

  // State for analytics data
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [trends, setTrends] = useState<TrendData | null>(null);
  const [distribution, setDistribution] = useState<DistributionData | null>(null);
  const [velocity, setVelocity] = useState<VelocityData | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<AnalyticsPeriod>(
    DEFAULT_ANALYTICS_CONFIG.defaultPeriod
  );
  const [isEnabled, setIsEnabled] = useState<boolean | null>(null);

  // Calculate date range based on selected period
  const dateRange = useMemo(() => getDefaultDateRange(selectedPeriod), [selectedPeriod]);

  /**
   * Check if analytics feature is enabled
   */
  const checkFeatureEnabled = useCallback(async () => {
    try {
      const result = await window.electronAPI.analytics?.isEnabled();
      if (result?.success) {
        setIsEnabled(result.data ?? false);
      } else {
        setIsEnabled(false);
      }
    } catch (err) {
      console.error('[Analytics] Failed to check feature status:', err);
      setIsEnabled(false);
    }
  }, []);

  /**
   * Load all analytics data for the selected period
   */
  const loadAnalyticsData = useCallback(async () => {
    if (!isEnabled) return;

    setIsLoading(true);
    setError(null);

    try {
      const queryOptions = {
        projectId,
        period: selectedPeriod,
        startDate: dateRange.start,
        endDate: dateRange.end,
        compareToPrevious: true,
      };

      // Fetch all analytics data in parallel
      const [overviewResult, trendsResult, distributionResult] = await Promise.all([
        projectId
          ? window.electronAPI.analytics?.getProjectMetrics(projectId, queryOptions)
          : Promise.resolve({ success: false, error: 'No project selected' }),
        projectId
          ? window.electronAPI.analytics?.getCompletionTrends(projectId, queryOptions)
          : Promise.resolve({ success: false, error: 'No project selected' }),
        projectId
          ? window.electronAPI.analytics?.getStatusDistribution(projectId)
          : Promise.resolve({ success: false, error: 'No project selected' }),
      ]);

      // Handle overview data
      if (overviewResult?.success && overviewResult.data) {
        setOverview(overviewResult.data);
      } else if (overviewResult?.error) {
        console.warn('[Analytics] Failed to load overview:', overviewResult.error);
      }

      // Handle trends data
      if (trendsResult?.success && trendsResult.data) {
        setTrends(trendsResult.data);
      } else if (trendsResult?.error) {
        console.warn('[Analytics] Failed to load trends:', trendsResult.error);
      }

      // Handle distribution data
      if (distributionResult?.success && distributionResult.data) {
        setDistribution(distributionResult.data);
      } else if (distributionResult?.error) {
        console.warn('[Analytics] Failed to load distribution:', distributionResult.error);
      }

      // Note: Velocity data would be computed from trends or a separate API call
      // For now, we'll derive it from trends data if available
      if (trendsResult?.success && trendsResult.data) {
        const velocityData: VelocityData = {
          periodType: selectedPeriod,
          dataPoints: trendsResult.data.completedTasks.map((point, index) => ({
            period: point.date,
            completed: point.value,
            created: trendsResult.data!.createdTasks[index]?.value || 0,
            netChange: point.value - (trendsResult.data!.createdTasks[index]?.value || 0),
          })),
          averageVelocity: trendsResult.data.velocity.length > 0
            ? trendsResult.data.velocity.reduce((sum, v) => sum + v.value, 0) / trendsResult.data.velocity.length
            : 0,
          totalCompleted: trendsResult.data.completedTasks.reduce((sum, v) => sum + v.value, 0),
          totalCreated: trendsResult.data.createdTasks.reduce((sum, v) => sum + v.value, 0),
        };
        setVelocity(velocityData);
      }
    } catch (err) {
      console.error('[Analytics] Failed to load analytics data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load analytics data');
    } finally {
      setIsLoading(false);
    }
  }, [isEnabled, projectId, selectedPeriod, dateRange.start, dateRange.end]);

  /**
   * Handle export to CSV or PDF
   */
  const handleExport = useCallback(async (format: ExportFormat) => {
    if (!isEnabled || !projectId) return;

    setIsExporting(true);

    try {
      // For now, log the export request
      // The actual export will be handled by the analytics-service via IPC
      console.log('[Analytics] Exporting as', format, {
        projectId,
        period: selectedPeriod,
        dateRange,
      });

      // TODO: Call the actual export IPC handler when implemented
      // const result = await window.electronAPI.analytics?.export({
      //   format,
      //   projectId,
      //   startDate: dateRange.start,
      //   endDate: dateRange.end,
      // });

      // Placeholder success message
      console.log('[Analytics] Export initiated');
    } catch (err) {
      console.error('[Analytics] Export failed:', err);
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  }, [isEnabled, projectId, selectedPeriod, dateRange]);

  /**
   * Handle period change
   */
  const handlePeriodChange = useCallback((period: string) => {
    setSelectedPeriod(period as AnalyticsPeriod);
  }, []);

  /**
   * Handle refresh
   */
  const handleRefresh = useCallback(async () => {
    if (projectId) {
      // Refresh cache if available
      await window.electronAPI.analytics?.refresh(projectId);
    }
    await loadAnalyticsData();
  }, [projectId, loadAnalyticsData]);

  // Check feature enabled on mount
  useEffect(() => {
    checkFeatureEnabled();
  }, [checkFeatureEnabled]);

  // Load analytics data when enabled, period, or project changes
  useEffect(() => {
    if (isEnabled === true && projectId) {
      loadAnalyticsData();
    }
  }, [isEnabled, projectId, loadAnalyticsData]);

  // Feature disabled state
  if (isEnabled === false) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center p-8', className)}>
        <div className="text-center max-w-md">
          <BarChart3 className="h-16 w-16 text-muted-foreground/50 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Analytics Not Enabled
          </h2>
          <p className="text-muted-foreground mb-4">
            The analytics feature is currently disabled. Enable it in your environment
            configuration to view task metrics and insights.
          </p>
          <p className="text-sm text-muted-foreground">
            Set <code className="bg-muted px-1 py-0.5 rounded">ENABLE_ANALYTICS=true</code> to enable.
          </p>
        </div>
      </div>
    );
  }

  // Loading feature status
  if (isEnabled === null) {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No project selected
  if (!projectId) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center p-8', className)}>
        <div className="text-center max-w-md">
          <BarChart3 className="h-16 w-16 text-muted-foreground/50 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">
            No Project Selected
          </h2>
          <p className="text-muted-foreground">
            Select a project to view analytics and metrics.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden', className)}>
      {/* Header with controls */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold text-foreground">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Task metrics and insights
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Date Range Selector */}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Select value={selectedPeriod} onValueChange={handlePeriodChange}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Export Dropdown */}
          <Select
            value=""
            onValueChange={(value) => handleExport(value as ExportFormat)}
            disabled={isExporting || isLoading}
          >
            <SelectTrigger className="w-[130px]">
              <div className="flex items-center gap-2">
                {isExporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                <span>Export</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">Export as CSV</SelectItem>
              <SelectItem value="pdf">Export as PDF</SelectItem>
              <SelectItem value="json">Export as JSON</SelectItem>
            </SelectContent>
          </Select>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefresh}
            disabled={isLoading}
            aria-label={t('buttons.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-6">
        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">Error loading analytics</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              className="mt-3"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('buttons.retry')}
            </Button>
          </div>
        )}

        {/* Loading state */}
        {isLoading && !overview && !error && (
          <div className="flex h-64 items-center justify-center">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
              <p className="text-muted-foreground">{t('labels.loading')}</p>
            </div>
          </div>
        )}

        {/* Analytics content */}
        {!isLoading && !error && (
          <div className="space-y-6">
            {/* Date range info */}
            <div className="text-sm text-muted-foreground">
              Showing data from <span className="font-medium text-foreground">{dateRange.start}</span> to{' '}
              <span className="font-medium text-foreground">{dateRange.end}</span>
            </div>

            {/* Metrics Overview Section */}
            <section>
              <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                Overview
              </h2>
              {overview ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Placeholder cards - will be replaced by MetricsOverview component */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Total Tasks</CardDescription>
                      <CardTitle className="text-3xl">{overview.totalTasks}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        {overview.taskCountChange !== undefined && (
                          <span className={cn(
                            'font-medium',
                            overview.taskCountChange >= 0 ? 'text-success' : 'text-destructive'
                          )}>
                            {overview.taskCountChange >= 0 ? '+' : ''}{overview.taskCountChange}%
                          </span>
                        )} vs previous period
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Completed</CardDescription>
                      <CardTitle className="text-3xl">{overview.completedTasks}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-medium text-success">{overview.completionRate}%</span> completion rate
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>In Progress</CardDescription>
                      <CardTitle className="text-3xl">{overview.inProgressTasks}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        Currently being worked on
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardDescription>Velocity</CardDescription>
                      <CardTitle className="text-3xl">{overview.velocityPerWeek.toFixed(1)}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        tasks/week
                        {overview.velocityChange !== undefined && (
                          <span className={cn(
                            'ml-1 font-medium',
                            overview.velocityChange >= 0 ? 'text-success' : 'text-destructive'
                          )}>
                            ({overview.velocityChange >= 0 ? '+' : ''}{overview.velocityChange}%)
                          </span>
                        )}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <Card className="p-8">
                  <div className="text-center text-muted-foreground">
                    <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                    <p>{t('labels.noData')}</p>
                  </div>
                </Card>
              )}
            </section>

            {/* Charts Section - Placeholder for child components */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Trends Chart Placeholder */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    Completion Trends
                  </CardTitle>
                  <CardDescription>
                    Tasks completed over time
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {trends ? (
                    <div className="h-64 flex items-center justify-center border border-dashed border-border rounded-lg bg-muted/20">
                      <p className="text-sm text-muted-foreground">
                        TrendsChart component will render here
                      </p>
                    </div>
                  ) : (
                    <div className="h-64 flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">{t('labels.noData')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Distribution Chart Placeholder */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <PieChart className="h-5 w-5 text-primary" />
                    Status Distribution
                  </CardTitle>
                  <CardDescription>
                    Tasks by current status
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {distribution ? (
                    <div className="h-64 flex items-center justify-center border border-dashed border-border rounded-lg bg-muted/20">
                      <p className="text-sm text-muted-foreground">
                        DistributionChart component will render here
                      </p>
                    </div>
                  ) : (
                    <div className="h-64 flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">{t('labels.noData')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>

            {/* Velocity Chart Section - Full width */}
            <section>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-primary" />
                    Velocity
                  </CardTitle>
                  <CardDescription>
                    Tasks created vs completed per period
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {velocity ? (
                    <div className="h-64 flex items-center justify-center border border-dashed border-border rounded-lg bg-muted/20">
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground mb-2">
                          VelocityChart component will render here
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Total completed: {velocity.totalCompleted} | Total created: {velocity.totalCreated}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="h-64 flex items-center justify-center">
                      <p className="text-sm text-muted-foreground">{t('labels.noData')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default Analytics;
