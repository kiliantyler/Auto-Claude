import { create } from 'zustand';

/**
 * Migration status for a single project
 */
export type MigrationStatus = 'idle' | 'running' | 'completed' | 'failed';

/**
 * Migration progress data for a project
 */
export interface MigrationProgress {
  status: MigrationStatus;
  progress: number; // 0-100
  currentFile: string | null; // e.g., 'tasks.json', 'implementation_plan.json'
  error: string | null;
  startedAt: string | null; // ISO timestamp
  completedAt: string | null; // ISO timestamp
}

interface MigrationState {
  // Migration data keyed by project path
  migrations: Record<string, MigrationProgress>;

  // Loading state (global)
  isLoading: boolean;

  // Actions
  setMigrationProgress: (
    projectPath: string,
    progress: number,
    currentFile: string
  ) => void;
  setMigrationComplete: (projectPath: string) => void;
  setMigrationError: (projectPath: string, error: string) => void;
  setMigrationStarted: (projectPath: string) => void;
  clearMigration: (projectPath: string) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;

  // Selectors
  getMigrationStatus: (projectPath: string) => MigrationProgress | null;
  isAnyMigrationRunning: () => boolean;
  hasAnyMigrationFailed: () => boolean;
  getRunningMigrations: () => string[];
}

const initialState = {
  migrations: {},
  isLoading: false,
};

export const useMigrationStore = create<MigrationState>((set, get) => ({
  ...initialState,

  setMigrationProgress: (projectPath, progress, currentFile) =>
    set((state) => ({
      migrations: {
        ...state.migrations,
        [projectPath]: {
          ...(state.migrations[projectPath] || {
            status: 'running' as MigrationStatus,
            progress: 0,
            currentFile: null,
            error: null,
            startedAt: null,
            completedAt: null,
          }),
          status: 'running' as MigrationStatus,
          progress,
          currentFile,
          error: null,
        },
      },
    })),

  setMigrationComplete: (projectPath) =>
    set((state) => {
      const existing = state.migrations[projectPath];
      if (!existing) return state;

      return {
        migrations: {
          ...state.migrations,
          [projectPath]: {
            ...existing,
            status: 'completed' as MigrationStatus,
            progress: 100,
            currentFile: null,
            error: null,
            completedAt: new Date().toISOString(),
          },
        },
      };
    }),

  setMigrationError: (projectPath, error) =>
    set((state) => {
      const existing = state.migrations[projectPath];
      if (!existing) return state;

      return {
        migrations: {
          ...state.migrations,
          [projectPath]: {
            ...existing,
            status: 'failed' as MigrationStatus,
            error,
            completedAt: new Date().toISOString(),
          },
        },
      };
    }),

  setMigrationStarted: (projectPath) =>
    set((state) => ({
      migrations: {
        ...state.migrations,
        [projectPath]: {
          status: 'running' as MigrationStatus,
          progress: 0,
          currentFile: null,
          error: null,
          startedAt: new Date().toISOString(),
          completedAt: null,
        },
      },
    })),

  clearMigration: (projectPath) =>
    set((state) => {
      const { [projectPath]: _, ...rest } = state.migrations;
      return { migrations: rest };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  reset: () => set(initialState),

  getMigrationStatus: (projectPath) => {
    const state = get();
    return state.migrations[projectPath] || null;
  },

  isAnyMigrationRunning: () => {
    const state = get();
    return Object.values(state.migrations).some(
      (m) => m.status === 'running'
    );
  },

  hasAnyMigrationFailed: () => {
    const state = get();
    return Object.values(state.migrations).some(
      (m) => m.status === 'failed'
    );
  },

  getRunningMigrations: () => {
    const state = get();
    return Object.keys(state.migrations).filter(
      (path) => state.migrations[path].status === 'running'
    );
  },
}));
