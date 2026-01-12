import { create } from 'zustand';
import type {
  AnalyticsOverview,
  TrendData,
  DistributionData,
  AnalyticsPeriod,
  AnalyticsQueryOptions,
} from '../../shared/types';
import type { ProductivityStats } from '../../preload/api/modules/analytics-api';
import { getDefaultDateRange, DEFAULT_ANALYTICS_CONFIG } from '../../shared/types/analytics';

interface AnalyticsState {
  // Analytics data
  overview: AnalyticsOverview | null;
  trends: TrendData | null;
  distribution: DistributionData | null;
  productivityStats: ProductivityStats | null;
  // Selected project
  selectedProjectId: string | null;
  // Time period configuration
  selectedPeriod: AnalyticsPeriod;
  dateRange: {
    start: string;
    end: string;
  };
  // Loading states
  isLoading: boolean;
  isLoadingOverview: boolean;
  isLoadingTrends: boolean;
  isLoadingDistribution: boolean;
  isLoadingProductivity: boolean;
  // Error state
  error: string | null;
  // Feature flag
  isEnabled: boolean;
  // Cache/refresh tracking
  lastRefresh: string | null;

  // Actions
  setOverview: (overview: AnalyticsOverview | null) => void;
  setTrends: (trends: TrendData | null) => void;
  setDistribution: (distribution: DistributionData | null) => void;
  setProductivityStats: (stats: ProductivityStats | null) => void;
  setSelectedProject: (projectId: string | null) => void;
  setSelectedPeriod: (period: AnalyticsPeriod) => void;
  setDateRange: (start: string, end: string) => void;
  setLoading: (loading: boolean) => void;
  setLoadingOverview: (loading: boolean) => void;
  setLoadingTrends: (loading: boolean) => void;
  setLoadingDistribution: (loading: boolean) => void;
  setLoadingProductivity: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  setLastRefresh: (timestamp: string | null) => void;
  clearAll: () => void;
  reset: () => void;

  // Selectors
  getCompletionRate: () => number;
  getVelocity: () => number;
  hasData: () => boolean;
  isAnyLoading: () => boolean;
}

const defaultDateRange = getDefaultDateRange(DEFAULT_ANALYTICS_CONFIG.defaultPeriod);

const initialState = {
  overview: null,
  trends: null,
  distribution: null,
  productivityStats: null,
  selectedProjectId: null,
  selectedPeriod: DEFAULT_ANALYTICS_CONFIG.defaultPeriod,
  dateRange: defaultDateRange,
  isLoading: false,
  isLoadingOverview: false,
  isLoadingTrends: false,
  isLoadingDistribution: false,
  isLoadingProductivity: false,
  error: null,
  isEnabled: false,
  lastRefresh: null,
};

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  ...initialState,

  setOverview: (overview) => set({ overview }),

  setTrends: (trends) => set({ trends }),

  setDistribution: (distribution) => set({ distribution }),

  setProductivityStats: (productivityStats) => set({ productivityStats }),

  setSelectedProject: (selectedProjectId) =>
    set({
      selectedProjectId,
      // Clear data when project changes
      overview: null,
      trends: null,
      distribution: null,
      productivityStats: null,
      error: null,
    }),

  setSelectedPeriod: (selectedPeriod) => {
    const newDateRange = getDefaultDateRange(selectedPeriod);
    set({
      selectedPeriod,
      dateRange: newDateRange,
      // Clear data when period changes
      overview: null,
      trends: null,
      error: null,
    });
  },

  setDateRange: (start, end) =>
    set({
      dateRange: { start, end },
      selectedPeriod: 'custom',
      // Clear data when date range changes
      overview: null,
      trends: null,
      error: null,
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setLoadingOverview: (isLoadingOverview) => set({ isLoadingOverview }),

  setLoadingTrends: (isLoadingTrends) => set({ isLoadingTrends }),

  setLoadingDistribution: (isLoadingDistribution) => set({ isLoadingDistribution }),

  setLoadingProductivity: (isLoadingProductivity) => set({ isLoadingProductivity }),

  setError: (error) => set({ error, isLoading: false }),

  setEnabled: (isEnabled) => set({ isEnabled }),

  setLastRefresh: (lastRefresh) => set({ lastRefresh }),

  clearAll: () =>
    set({
      overview: null,
      trends: null,
      distribution: null,
      productivityStats: null,
      error: null,
      lastRefresh: null,
    }),

  reset: () => set(initialState),

  getCompletionRate: () => {
    const state = get();
    return state.overview?.completionRate ?? 0;
  },

  getVelocity: () => {
    const state = get();
    return state.overview?.velocityPerDay ?? 0;
  },

  hasData: () => {
    const state = get();
    return !!(state.overview || state.trends || state.distribution);
  },

  isAnyLoading: () => {
    const state = get();
    return (
      state.isLoading ||
      state.isLoadingOverview ||
      state.isLoadingTrends ||
      state.isLoadingDistribution ||
      state.isLoadingProductivity
    );
  },
}));

// ============================================
// Async Actions (outside store for cleaner API)
// ============================================

/**
 * Check if analytics feature is enabled
 * Note: Uses isEnabled() which maps to analytics:is-enabled IPC channel
 * The analytics API is spread last in createElectronAPI, so its isEnabled takes precedence
 */
export async function checkAnalyticsEnabled(): Promise<boolean> {
  const store = useAnalyticsStore.getState();

  try {
    const result = await window.electronAPI.isEnabled();
    if (result.success && result.data !== undefined) {
      store.setEnabled(result.data);
      return result.data;
    }
    return false;
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to check analytics status');
    return false;
  }
}

/**
 * Load overview metrics for a project
 */
export async function loadOverview(projectId: string, options?: AnalyticsQueryOptions): Promise<void> {
  const store = useAnalyticsStore.getState();
  store.setLoadingOverview(true);
  store.setError(null);

  try {
    const queryOptions: AnalyticsQueryOptions = {
      ...options,
      startDate: options?.startDate ?? store.dateRange.start,
      endDate: options?.endDate ?? store.dateRange.end,
      period: options?.period ?? store.selectedPeriod,
    };

    const result = await window.electronAPI.getProjectMetrics(projectId, queryOptions);
    if (result.success && result.data) {
      store.setOverview(result.data);
    } else {
      store.setError(result.error || 'Failed to load analytics overview');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading analytics');
  } finally {
    store.setLoadingOverview(false);
  }
}

/**
 * Load trend data for charts
 */
export async function loadTrends(projectId?: string, options?: AnalyticsQueryOptions): Promise<void> {
  const store = useAnalyticsStore.getState();
  store.setLoadingTrends(true);
  store.setError(null);

  try {
    const queryOptions: AnalyticsQueryOptions = {
      ...options,
      startDate: options?.startDate ?? store.dateRange.start,
      endDate: options?.endDate ?? store.dateRange.end,
      period: options?.period ?? store.selectedPeriod,
    };

    const result = await window.electronAPI.getCompletionTrends(
      projectId ?? store.selectedProjectId ?? undefined,
      queryOptions
    );
    if (result.success && result.data) {
      store.setTrends(result.data);
    } else {
      store.setError(result.error || 'Failed to load trend data');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading trends');
  } finally {
    store.setLoadingTrends(false);
  }
}

/**
 * Load distribution data for pie/donut charts
 */
export async function loadDistribution(projectId?: string): Promise<void> {
  const store = useAnalyticsStore.getState();
  store.setLoadingDistribution(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getStatusDistribution(
      projectId ?? store.selectedProjectId ?? undefined
    );
    if (result.success && result.data) {
      store.setDistribution(result.data);
    } else {
      store.setError(result.error || 'Failed to load distribution data');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading distribution');
  } finally {
    store.setLoadingDistribution(false);
  }
}

/**
 * Load productivity statistics
 */
export async function loadProductivityStats(
  projectId?: string,
  period?: AnalyticsPeriod
): Promise<void> {
  const store = useAnalyticsStore.getState();
  store.setLoadingProductivity(true);
  store.setError(null);

  try {
    const result = await window.electronAPI.getProductivityStats(
      projectId ?? store.selectedProjectId ?? undefined,
      period ?? store.selectedPeriod
    );
    if (result.success && result.data) {
      store.setProductivityStats(result.data);
    } else {
      store.setError(result.error || 'Failed to load productivity stats');
    }
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Unknown error loading productivity stats');
  } finally {
    store.setLoadingProductivity(false);
  }
}

/**
 * Load all analytics data for a project
 */
export async function loadAllAnalytics(projectId: string): Promise<void> {
  const store = useAnalyticsStore.getState();
  store.setLoading(true);
  store.setError(null);
  store.setSelectedProject(projectId);

  try {
    // Load all data in parallel
    await Promise.all([
      loadOverview(projectId),
      loadTrends(projectId),
      loadDistribution(projectId),
      loadProductivityStats(projectId),
    ]);

    store.setLastRefresh(new Date().toISOString());
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to load analytics');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Refresh analytics data
 */
export async function refreshAnalytics(): Promise<void> {
  const store = useAnalyticsStore.getState();
  const projectId = store.selectedProjectId;

  if (!projectId) {
    return;
  }

  store.setLoading(true);
  store.setError(null);

  try {
    // Trigger cache refresh on backend
    await window.electronAPI.refresh(projectId);

    // Reload all data
    await loadAllAnalytics(projectId);
  } catch (error) {
    store.setError(error instanceof Error ? error.message : 'Failed to refresh analytics');
  } finally {
    store.setLoading(false);
  }
}

/**
 * Initialize analytics store
 */
export async function initializeAnalyticsStore(): Promise<void> {
  await checkAnalyticsEnabled();
}

// ============================================
// Utility Functions
// ============================================

/**
 * Format period for display
 */
export function formatPeriodLabel(period: AnalyticsPeriod): string {
  switch (period) {
    case 'day':
      return 'Today';
    case 'week':
      return 'This Week';
    case 'month':
      return 'This Month';
    case 'quarter':
      return 'This Quarter';
    case 'year':
      return 'This Year';
    case 'custom':
      return 'Custom Range';
    default:
      return period;
  }
}

/**
 * Get period options for dropdown
 */
export function getPeriodOptions(): Array<{ value: AnalyticsPeriod; label: string }> {
  return [
    { value: 'day', label: 'Today' },
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
    { value: 'quarter', label: 'This Quarter' },
    { value: 'year', label: 'This Year' },
    { value: 'custom', label: 'Custom Range' },
  ];
}

/**
 * Format a number with abbreviation (e.g., 1.2K, 3.4M)
 */
export function formatNumber(num: number): string {
  if (num < 1000) {
    return num.toString();
  }
  if (num < 1000000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/**
 * Format percentage with sign
 */
export function formatPercentageChange(value: number | undefined): string {
  if (value === undefined || value === 0) {
    return '0%';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/**
 * Get color class for percentage change
 */
export function getChangeColor(value: number | undefined): string {
  if (value === undefined || value === 0) {
    return 'text-gray-500';
  }
  return value > 0 ? 'text-green-500' : 'text-red-500';
}

/**
 * Calculate days between two dates
 */
export function getDaysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end.getTime() - start.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Get a summary string for the current analytics state
 */
export function getAnalyticsSummary(): string {
  const store = useAnalyticsStore.getState();

  if (!store.overview) {
    return 'No analytics data available';
  }

  const { totalTasks, completedTasks, completionRate, velocityPerDay } = store.overview;

  return `${completedTasks}/${totalTasks} tasks completed (${completionRate}%), ${velocityPerDay.toFixed(1)} tasks/day`;
}

/**
 * Check if analytics data needs refresh based on lastRefresh timestamp
 */
export function needsRefresh(thresholdMs: number = DEFAULT_ANALYTICS_CONFIG.refreshIntervalMs): boolean {
  const store = useAnalyticsStore.getState();

  if (!store.lastRefresh) {
    return true;
  }

  const lastRefreshTime = new Date(store.lastRefresh).getTime();
  const now = Date.now();

  return now - lastRefreshTime > thresholdMs;
}
