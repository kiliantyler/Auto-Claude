import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, Dirent } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project, ProjectSettings, Task, TaskStatus, TaskMetadata, ImplementationPlan, ReviewReason, PlanSubtask, ExecutionPhase } from '../shared/types';
import { DEFAULT_PROJECT_SETTINGS, AUTO_BUILD_PATHS, getSpecsDir } from '../shared/constants';
import { getAutoBuildPath, isInitialized } from './project-initializer';
import { getTaskWorktreeDir } from './worktree-paths';
import { getDatabaseConnection } from './database';
import { getMigrationTracker } from './migration-tracker';
import { getMigrationWorker } from './migration-worker';

interface TabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

interface StoreData {
  projects: Project[];
  settings: Record<string, unknown>;
  tabState?: TabState;
}

interface TasksCacheEntry {
  tasks: Task[];
  timestamp: number;
}

/**
 * Persistent storage for projects and settings
 */
export class ProjectStore {
  private storePath: string;
  private data: StoreData;
  private tasksCache: Map<string, TasksCacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 3000; // 3 seconds TTL for task cache
  private readonly ENABLE_DUAL_WRITE: boolean;

  constructor() {
    // Store in app's userData directory
    const userDataPath = app.getPath('userData');
    const storeDir = path.join(userDataPath, 'store');

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }

    this.storePath = path.join(storeDir, 'projects.json');
    this.data = this.load();

    // Disable dual-write by default (Phase 4 - SQLite-only mode)
    // Set ENABLE_DUAL_WRITE=true to enable dual-write for debugging
    this.ENABLE_DUAL_WRITE = process.env.ENABLE_DUAL_WRITE === 'true';
    console.log(`[ProjectStore] Dual-write mode: ${this.ENABLE_DUAL_WRITE ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Load store from disk
   */
  private load(): StoreData {
    if (existsSync(this.storePath)) {
      try {
        const content = readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(content);
        // Convert date strings back to Date objects
        data.projects = data.projects.map((p: Project) => ({
          ...p,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.updatedAt)
        }));
        return data;
      } catch {
        return { projects: [], settings: {} };
      }
    }
    return { projects: [], settings: {} };
  }

  /**
   * Save store to disk
   */
  private save(): void {
    writeFileSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Write project to SQLite database
   * Used by dual-write system to keep database in sync with JSON files
   */
  private writeProjectToDatabase(project: Project): void {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO projects (id, name, path, auto_build_path, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        project.id,
        project.name,
        project.path,
        project.autoBuildPath,
        JSON.stringify(project.settings),
        project.createdAt.toISOString(),
        project.updatedAt.toISOString()
      );
    } catch (error) {
      console.error('[ProjectStore] Failed to write project to database:', error);
      // Don't throw - dual-write should not block if database fails
    }
  }

  /**
   * Delete project from SQLite database
   * Used by dual-write system to keep database in sync with JSON files
   */
  private deleteProjectFromDatabase(projectId: string): void {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare('DELETE FROM projects WHERE id = ?');
      stmt.run(projectId);
    } catch (error) {
      console.error('[ProjectStore] Failed to delete project from database:', error);
      // Don't throw - dual-write should not block if database fails
    }
  }

  /**
   * Read projects from SQLite database
   * Used by read operations to query database instead of JSON
   */
  private readProjectsFromDatabase(): Project[] {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC');
      const rows = stmt.all() as Array<{
        id: string;
        name: string;
        path: string;
        auto_build_path: string;
        settings_json: string;
        created_at: string;
        updated_at: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        autoBuildPath: row.auto_build_path,
        settings: JSON.parse(row.settings_json),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      }));
    } catch (error) {
      console.error('[ProjectStore] Failed to read projects from database:', error);
      return [];
    }
  }

  /**
   * Detect and trigger migration for a project if needed
   * Checks if JSON files exist and migration hasn't been completed yet
   *
   * @param project - Project to check for migration
   */
  private async detectAndMigrateIfNeeded(project: Project): Promise<void> {
    const tracker = getMigrationTracker();
    const worker = getMigrationWorker();

    // Check if already migrated
    if (tracker.hasMigrated(project.path)) {
      return;
    }

    // Check if JSON files exist in .auto-claude directory
    const autoBuildDir = path.join(project.path, '.auto-claude');
    if (!existsSync(autoBuildDir)) {
      return;
    }

    const jsonFiles = ['tasks.json', 'implementation_plan.json', 'task_logs.json'];
    const foundFiles = jsonFiles.filter(file => existsSync(path.join(autoBuildDir, file)));

    if (foundFiles.length === 0) {
      return;
    }

    // Trigger migration in background
    console.log(`[ProjectStore] Starting migration for project: ${project.name} (found: ${foundFiles.join(', ')})`);

    try {
      await worker.migrate(project.path, (progress) => {
        // Send progress to renderer via IPC if window exists
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
          mainWindow.webContents.send('migration:progress', progress);
        }
      });

      console.log(`[ProjectStore] Completed migration for project: ${project.name}`);
    } catch (error) {
      console.error(`[ProjectStore] Failed to migrate project ${project.name}:`, error);
      // Don't throw - allow app to continue functioning
    }
  }

  /**
   * Add a new project
   */
  addProject(projectPath: string, name?: string): Project {
    // Check if project already exists
    const existing = this.data.projects.find((p) => p.path === projectPath);
    if (existing) {
      // Validate that .auto-claude folder still exists for existing project
      // If manually deleted, reset autoBuildPath so UI prompts for reinitialization
      if (existing.autoBuildPath && !isInitialized(existing.path)) {
        console.warn(`[ProjectStore] .auto-claude folder was deleted for project "${existing.name}" - resetting autoBuildPath`);
        existing.autoBuildPath = '';
        existing.updatedAt = new Date();

        // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
        if (this.ENABLE_DUAL_WRITE) {
          this.save();
          this.writeProjectToDatabase(existing);
        } else {
          this.writeProjectToDatabase(existing);
        }
      }
      return existing;
    }

    // Derive name from path if not provided
    const projectName = name || path.basename(projectPath);

    // Determine auto-claude path (supports both 'auto-claude' and '.auto-claude')
    const autoBuildPath = getAutoBuildPath(projectPath) || '';

    const project: Project = {
      id: uuidv4(),
      name: projectName,
      path: projectPath,
      autoBuildPath,
      settings: { ...DEFAULT_PROJECT_SETTINGS },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
    this.data.projects.push(project);
    if (this.ENABLE_DUAL_WRITE) {
      this.save();
      this.writeProjectToDatabase(project);
    } else {
      this.writeProjectToDatabase(project);
    }

    return project;
  }

  /**
   * Update project's autoBuildPath after initialization
   */
  updateAutoBuildPath(projectId: string, autoBuildPath: string): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.autoBuildPath = autoBuildPath;
      project.updatedAt = new Date();

      // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.writeProjectToDatabase(project);
      } else {
        this.writeProjectToDatabase(project);
      }
    }
    return project;
  }

  /**
   * Remove a project
   */
  removeProject(projectId: string): boolean {
    const index = this.data.projects.findIndex((p) => p.id === projectId);
    if (index !== -1) {
      this.data.projects.splice(index, 1);

      // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.deleteProjectFromDatabase(projectId);
      } else {
        this.deleteProjectFromDatabase(projectId);
      }
      return true;
    }
    return false;
  }

  /**
   * Get all projects
   * Reads from SQLite database (with fallback to JSON for safety during migration)
   */
  getProjects(): Project[] {
    if (this.ENABLE_DUAL_WRITE) {
      // Phase 1: Read from SQLite with fallback to JSON
      const dbProjects = this.readProjectsFromDatabase();
      if (dbProjects.length > 0) {
        // Update in-memory cache with database data for consistency
        this.data.projects = dbProjects;
        return dbProjects;
      }
      // Fallback to JSON if database is empty or has errors
      console.warn('[ProjectStore] Database is empty, falling back to JSON');
      return this.data.projects;
    } else {
      // Phase 2+: JSON files are still maintained as backup
      return this.data.projects;
    }
  }

  /**
   * Get tab state
   */
  getTabState(): TabState {
    return this.data.tabState || {
      openProjectIds: [],
      activeProjectId: null,
      tabOrder: []
    };
  }

  /**
   * Save tab state
   */
  saveTabState(tabState: TabState): void {
    // Filter out any project IDs that no longer exist
    const validProjectIds = this.data.projects.map(p => p.id);
    this.data.tabState = {
      openProjectIds: tabState.openProjectIds.filter(id => validProjectIds.includes(id)),
      activeProjectId: tabState.activeProjectId && validProjectIds.includes(tabState.activeProjectId)
        ? tabState.activeProjectId
        : null,
      tabOrder: tabState.tabOrder.filter(id => validProjectIds.includes(id))
    };
    console.log('[ProjectStore] Saving tab state:', this.data.tabState);
    this.save();
  }

  /**
   * Validate all projects to ensure their .auto-claude folders still exist.
   * If a project has autoBuildPath set but the folder was deleted,
   * reset autoBuildPath to empty string so the UI prompts for reinitialization.
   *
   * @returns Array of project IDs that were reset due to missing .auto-claude folder
   */
  validateProjects(): string[] {
    const resetProjectIds: string[] = [];
    let hasChanges = false;

    for (const project of this.data.projects) {
      // Skip projects that aren't initialized (autoBuildPath is empty)
      if (!project.autoBuildPath) {
        continue;
      }

      // Check if the project path still exists
      if (!existsSync(project.path)) {
        console.warn(`[ProjectStore] Project path no longer exists: ${project.path}`);
        continue; // Don't reset - let user handle this case
      }

      // Check if .auto-claude folder still exists
      if (!isInitialized(project.path)) {
        console.warn(`[ProjectStore] .auto-claude folder missing for project "${project.name}" at ${project.path}`);
        project.autoBuildPath = '';
        project.updatedAt = new Date();
        resetProjectIds.push(project.id);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
      }

      // Update all modified projects in database
      for (const projectId of resetProjectIds) {
        const project = this.data.projects.find((p) => p.id === projectId);
        if (project) {
          this.writeProjectToDatabase(project);
        }
      }

      console.warn(`[ProjectStore] Reset ${resetProjectIds.length} project(s) due to missing .auto-claude folder`);
    }

    return resetProjectIds;
  }

  /**
   * Get a project by ID
   */
  getProject(projectId: string): Project | undefined {
    return this.data.projects.find((p) => p.id === projectId);
  }

  /**
   * Update project settings
   */
  updateProjectSettings(
    projectId: string,
    settings: Partial<ProjectSettings>
  ): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.settings = { ...project.settings, ...settings };
      project.updatedAt = new Date();

      // Write to storage (dual-write mode: both JSON + DB, SQLite-only mode: DB only)
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.writeProjectToDatabase(project);
      } else {
        this.writeProjectToDatabase(project);
      }
    }
    return project;
  }

  /**
   * Read tasks from SQLite database
   * Used by read operations to query database instead of scanning directories
   */
  private readTasksFromDatabase(projectId: string): Task[] {
    try {
      const db = getDatabaseConnection().getConnection();
      const stmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC');
      const rows = stmt.all(projectId) as Array<{
        id: string;
        spec_id: string;
        project_id: string;
        title: string;
        description: string;
        status: string;
        review_reason: string | null;
        released_in_version: string | null;
        staged_in_main_project: number;
        staged_at: string | null;
        location: string | null;
        specs_path: string | null;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>;

      return rows.map((row) => {
        // Parse metadata JSON
        const metadataWithExtras = JSON.parse(row.metadata_json) as {
          subtasks?: Task['subtasks'];
          qaReport?: Task['qaReport'];
          logs?: Task['logs'];
          executionProgress?: Task['executionProgress'];
          sourceType?: string;
          archivedAt?: string;
          archivedInVersion?: string;
        };

        // Extract nested fields from metadata JSON
        const { subtasks, qaReport, logs, executionProgress, ...metadata } = metadataWithExtras;

        return {
          id: row.id,
          specId: row.spec_id,
          projectId: row.project_id,
          title: row.title,
          description: row.description,
          status: row.status as TaskStatus,
          reviewReason: row.review_reason as ReviewReason | undefined,
          releasedInVersion: row.released_in_version || undefined,
          stagedInMainProject: row.staged_in_main_project === 1,
          stagedAt: row.staged_at || undefined,
          location: row.location as 'main' | 'worktree' | undefined,
          specsPath: row.specs_path || undefined,
          subtasks: subtasks || [],
          qaReport: qaReport,
          logs: logs || [],
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          executionProgress: executionProgress,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        };
      });
    } catch (error) {
      console.error('[ProjectStore] Failed to read tasks from database:', error);
      return [];
    }
  }

  /**
   * Get tasks for a project from SQLite database
   * Implements caching with 3-second TTL to prevent excessive database queries
   *
   * NOTE: Tasks are now stored exclusively in SQLite.
   * JSON files are only read during migration to populate the database.
   */
  getTasks(projectId: string): Task[] {
    // Check cache first
    const cached = this.tasksCache.get(projectId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
      console.debug('[ProjectStore] Returning cached tasks for project:', projectId, '(age:', now - cached.timestamp, 'ms)');
      return cached.tasks;
    }

    console.debug('[ProjectStore] getTasks called with projectId:', projectId, cached ? '(cache expired)' : '(cache miss)');
    const project = this.getProject(projectId);
    if (!project) {
      console.warn('[ProjectStore] Project not found for id:', projectId);
      return [];
    }

    // Trigger migration in background (non-blocking) when project is accessed
    // This ensures migration runs when user loads a project, not just at startup
    setImmediate(() => {
      this.detectAndMigrateIfNeeded(project).catch((error) => {
        console.error('[ProjectStore] Background migration failed for project:', project.name, error);
      });
    });

    // Read tasks from SQLite database (single source of truth)
    const tasks = this.readTasksFromDatabase(projectId);
    console.debug('[ProjectStore] Loaded', tasks.length, 'tasks from SQLite database');

    // Update cache
    this.tasksCache.set(projectId, { tasks, timestamp: now });

    return tasks;
  }

  /**
   * Scan tasks from directory (MIGRATION ONLY)
   * This method scans the specs directory and worktrees to load tasks from JSON files.
   *
   * @deprecated This method is only used during migration to populate SQLite database.
   * It should NOT be called during normal runtime. Use readTasksFromDatabase() instead.
   */
  scanTasksFromDirectory(project: Project, projectId: string): Task[] {
    const allTasks: Task[] = [];
    const specsBaseDir = getSpecsDir(project.autoBuildPath);

    // 1. Scan main project specs directory (source of truth for task existence)
    const mainSpecsDir = path.join(project.path, specsBaseDir);
    const mainSpecIds = new Set<string>();
    console.debug('[ProjectStore] Main specsDir:', mainSpecsDir, 'exists:', existsSync(mainSpecsDir));
    if (existsSync(mainSpecsDir)) {
      const mainTasks = this.loadTasksFromSpecsDir(mainSpecsDir, project.path, 'main', projectId, specsBaseDir);
      allTasks.push(...mainTasks);
      // Track which specs exist in main project
      mainTasks.forEach(t => mainSpecIds.add(t.specId));
      console.debug('[ProjectStore] Loaded', mainTasks.length, 'tasks from main project');
    }

    // 2. Scan worktree specs directories
    // NOTE FOR MAINTAINERS: Worktree tasks are only included if the spec also exists in main.
    // This prevents deleted tasks from "coming back" when the worktree isn't cleaned up.
    const worktreesDir = getTaskWorktreeDir(project.path);
    if (existsSync(worktreesDir)) {
      try {
        const worktrees = readdirSync(worktreesDir, { withFileTypes: true });
        for (const worktree of worktrees) {
          if (!worktree.isDirectory()) continue;

          const worktreeSpecsDir = path.join(worktreesDir, worktree.name, specsBaseDir);
          if (existsSync(worktreeSpecsDir)) {
            const worktreeTasks = this.loadTasksFromSpecsDir(
              worktreeSpecsDir,
              path.join(worktreesDir, worktree.name),
              'worktree',
              projectId,
              specsBaseDir
            );
            // Only include worktree tasks if the spec exists in main project
            const validWorktreeTasks = worktreeTasks.filter(t => mainSpecIds.has(t.specId));
            allTasks.push(...validWorktreeTasks);
            const skipped = worktreeTasks.length - validWorktreeTasks.length;
            console.debug('[ProjectStore] Loaded', validWorktreeTasks.length, 'tasks from worktree:', worktree.name, skipped > 0 ? `(skipped ${skipped} orphaned)` : '');
          }
        }
      } catch (error) {
        console.error('[ProjectStore] Error scanning worktrees:', error);
      }
    }

    // 3. Deduplicate tasks by ID (prefer worktree version if exists in both)
    const taskMap = new Map<string, Task>();
    for (const task of allTasks) {
      const existing = taskMap.get(task.id);
      if (!existing || task.location === 'worktree') {
        taskMap.set(task.id, task);
      }
    }

    const tasks = Array.from(taskMap.values());
    console.debug('[ProjectStore] Returning', tasks.length, 'unique tasks (after deduplication)');

    return tasks;
  }

  /**
   * Invalidate the tasks cache for a specific project
   * Call this when tasks are modified (created, deleted, status changed, etc.)
   */
  invalidateTasksCache(projectId: string): void {
    this.tasksCache.delete(projectId);
    console.debug('[ProjectStore] Invalidated tasks cache for project:', projectId);
  }

  /**
   * Clear all tasks cache entries
   * Useful for global refresh scenarios
   */
  clearTasksCache(): void {
    this.tasksCache.clear();
    console.debug('[ProjectStore] Cleared all tasks cache');
  }

  /**
   * Load tasks from a specs directory (MIGRATION ONLY)
   * Helper method used by scanTasksFromDirectory during migration.
   *
   * @deprecated This method is only used during migration to populate SQLite database.
   * It should NOT be called during normal runtime.
   */
  loadTasksFromSpecsDir(
    specsDir: string,
    basePath: string,
    location: 'main' | 'worktree',
    projectId: string,
    specsBaseDir: string
  ): Task[] {
    const tasks: Task[] = [];
    let specDirs: Dirent[] = [];

    try {
      specDirs = readdirSync(specsDir, { withFileTypes: true });
    } catch (error) {
      console.error('[ProjectStore] Error reading specs directory:', error);
      return [];
    }

    for (const dir of specDirs) {
      if (!dir.isDirectory()) continue;
      if (dir.name === '.gitkeep') continue;

      try {
        const specPath = path.join(specsDir, dir.name);
        const planPath = path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        const specFilePath = path.join(specPath, AUTO_BUILD_PATHS.SPEC_FILE);

        // Try to read implementation plan
        let plan: ImplementationPlan | null = null;
        if (existsSync(planPath)) {
          try {
            const content = readFileSync(planPath, 'utf-8');
            plan = JSON.parse(content);
          } catch {
            // Ignore parse errors
          }
        }

        // PRIORITY 1: Read description from implementation_plan.json (user's original)
        let description = '';
        if (plan?.description) {
          description = plan.description;
        }

        // PRIORITY 2: Fallback to requirements.json
        if (!description) {
          const requirementsPath = path.join(specPath, AUTO_BUILD_PATHS.REQUIREMENTS);
          if (existsSync(requirementsPath)) {
            try {
              const reqContent = readFileSync(requirementsPath, 'utf-8');
              const requirements = JSON.parse(reqContent);
              if (requirements.task_description) {
                // Use the full task description for the modal view
                description = requirements.task_description;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }

        // PRIORITY 3: Final fallback to spec.md Overview (AI-synthesized content)
        if (!description && existsSync(specFilePath)) {
          try {
            const content = readFileSync(specFilePath, 'utf-8');
            // Extract full Overview section until next heading or end of file
            // Use \n#{1,6}\s to match valid markdown headings (# to ######) with required space
            // This avoids truncating at # in code blocks (e.g., Python comments)
            const overviewMatch = content.match(/## Overview\s*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/);
            if (overviewMatch) {
              description = overviewMatch[1].trim();
            }
          } catch {
            // Ignore read errors
          }
        }

        // Try to read task metadata
        const metadataPath = path.join(specPath, 'task_metadata.json');
        let metadata: TaskMetadata | undefined;
        if (existsSync(metadataPath)) {
          try {
            const content = readFileSync(metadataPath, 'utf-8');
            metadata = JSON.parse(content);
          } catch {
            // Ignore parse errors
          }
        }

        // Determine task status and review reason from plan
        const { status, reviewReason } = this.determineTaskStatusAndReason(plan, specPath, metadata);

        // Extract subtasks from plan (handle both 'subtasks' and 'chunks' naming)
        // Also handle schema variations: 'id' vs 'subtask_id', 'description' vs 'title'
        const subtasks = plan?.phases?.flatMap((phase) => {
          const items = phase.subtasks || (phase as { chunks?: PlanSubtask[] }).chunks || [];
          return items.map((subtask) => {
            // Handle both 'id' and 'subtask_id' field names
            const subtaskAny = subtask as unknown as Record<string, unknown>;
            const subtaskId = subtask.id || subtaskAny.subtask_id as string;
            // Handle both 'description' and 'title' field names
            const subtaskDesc = subtask.description || subtaskAny.title as string;
            return {
              id: subtaskId,
              title: subtaskDesc,
              description: subtaskDesc,
              status: subtask.status,
              files: []
            };
          });
        }) || [];

        // Extract staged status from plan (set when changes are merged with --no-commit)
        const planWithStaged = plan as unknown as { stagedInMainProject?: boolean; stagedAt?: string } | null;
        const stagedInMainProject = planWithStaged?.stagedInMainProject;
        const stagedAt = planWithStaged?.stagedAt;

        // Derive execution progress from plan status
        // This ensures the UI shows correct phase (e.g., "Coding") instead of just "running"
        const executionPhaseMap: Record<string, ExecutionPhase> = {
          'planning': 'planning',
          'coding': 'coding',
          'in_progress': 'coding',  // Default active phase
          'review': 'qa_review',
          'qa_review': 'qa_review',
          'qa_fixing': 'qa_fixing',
          'completed': 'complete',
          'done': 'complete',
          'failed': 'failed'
        };
        const planStatus = plan?.status as string | undefined;
        const derivedPhase = planStatus ? executionPhaseMap[planStatus] : undefined;
        const executionProgress = derivedPhase ? {
          phase: derivedPhase,
          phaseProgress: 0,
          overallProgress: subtasks.length > 0
            ? Math.round((subtasks.filter(s => s.status === 'completed').length / subtasks.length) * 100)
            : 0
        } : undefined;

        // Determine title - check if feature looks like a spec ID (e.g., "054-something-something")
        let title = plan?.feature || plan?.title || dir.name;
        const looksLikeSpecId = /^\d{3}-/.test(title);
        if (looksLikeSpecId && existsSync(specFilePath)) {
          try {
            const specContent = readFileSync(specFilePath, 'utf-8');
            // Extract title from first # line, handling patterns like:
            // "# Quick Spec: Title" -> "Title"
            // "# Specification: Title" -> "Title"
            // "# Title" -> "Title"
            const titleMatch = specContent.match(/^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$/m);
            if (titleMatch && titleMatch[1]) {
              title = titleMatch[1].trim();
            }
          } catch {
            // Keep the original title on error
          }
        }

        tasks.push({
          id: dir.name, // Use spec directory name as ID
          specId: dir.name,
          projectId,
          title,
          description,
          status,
          reviewReason,
          subtasks,
          logs: [],
          metadata,
          stagedInMainProject,
          stagedAt,
          location, // Add location metadata (main vs worktree)
          specsPath: specPath, // Add full path to specs directory
          executionProgress, // Derived from plan status for correct UI display
          createdAt: new Date(plan?.created_at || Date.now()),
          updatedAt: new Date(plan?.updated_at || Date.now())
        });
      } catch (error) {
        // Log error but continue processing other specs
        console.error(`[ProjectStore] Error loading spec ${dir.name}:`, error);
      }
    }

    return tasks;
  }

  /**
   * Determine task status and review reason based on plan and files.
   *
   * This method calculates the correct status from subtask progress and QA state,
   * providing backwards compatibility for existing tasks with incorrect status.
   *
   * Review reasons:
   * - 'completed': All subtasks done, QA passed - ready for merge
   * - 'errors': Subtasks failed during execution - needs attention
   * - 'qa_rejected': QA found issues that need fixing
   */
  private determineTaskStatusAndReason(
    plan: ImplementationPlan | null,
    specPath: string,
    metadata?: TaskMetadata
  ): { status: TaskStatus; reviewReason?: ReviewReason } {
    // Handle both 'subtasks' and 'chunks' naming conventions, filter out undefined
    const allSubtasks = plan?.phases?.flatMap((p) => p.subtasks || (p as { chunks?: PlanSubtask[] }).chunks || []).filter(Boolean) || [];

    let calculatedStatus: TaskStatus = 'backlog';
    let reviewReason: ReviewReason | undefined;

    if (allSubtasks.length > 0) {
      const completed = allSubtasks.filter((s) => s.status === 'completed').length;
      const inProgress = allSubtasks.filter((s) => s.status === 'in_progress').length;
      const failed = allSubtasks.filter((s) => s.status === 'failed').length;

      if (completed === allSubtasks.length) {
        // All subtasks completed - check QA status
        const qaSignoff = (plan as unknown as Record<string, unknown>)?.qa_signoff as { status?: string } | undefined;
        if (qaSignoff?.status === 'approved') {
          calculatedStatus = 'human_review';
          reviewReason = 'completed';
        } else {
          // Manual tasks skip AI review and go directly to human review
          calculatedStatus = metadata?.sourceType === 'manual' ? 'human_review' : 'ai_review';
          if (metadata?.sourceType === 'manual') {
            reviewReason = 'completed';
          }
        }
      } else if (failed > 0) {
        // Some subtasks failed - needs human attention
        calculatedStatus = 'human_review';
        reviewReason = 'errors';
      } else if (inProgress > 0 || completed > 0) {
        calculatedStatus = 'in_progress';
      }
    }

    // FIRST: Check for explicit user-set status from plan (takes highest priority)
    // This allows users to manually mark tasks as 'done' via drag-and-drop
    if (plan?.status) {
      const statusMap: Record<string, TaskStatus> = {
        'pending': 'backlog',
        'planning': 'in_progress', // Task is in planning phase (spec creation running)
        'in_progress': 'in_progress',
        'coding': 'in_progress', // Task is in coding phase
        'review': 'ai_review',
        'completed': 'done',
        'done': 'done',
        'human_review': 'human_review',
        'ai_review': 'ai_review',
        'backlog': 'backlog'
      };
      const storedStatus = statusMap[plan.status];

      // If user explicitly marked as 'done', always respect that
      if (storedStatus === 'done') {
        return { status: 'done' };
      }

      // For other stored statuses, validate against calculated status
      if (storedStatus) {
        // Planning/coding status from the backend should be respected even if subtasks aren't in progress yet
        // This happens when a task is in planning phase (creating spec) but no subtasks have been started
        const isActiveProcessStatus = (plan.status as string) === 'planning' || (plan.status as string) === 'coding' || (plan.status as string) === 'in_progress';

        // Check if this is a plan review (spec approval stage before coding starts)
        // planStatus: "review" indicates spec creation is complete and awaiting user approval
        const isPlanReviewStage = (plan as unknown as { planStatus?: string })?.planStatus === 'review';

        // Determine if there is remaining work to do
        // True if: no subtasks exist yet (planning in progress) OR some subtasks are incomplete
        // This prevents 'in_progress' from overriding 'human_review' when all work is done
        const hasRemainingWork = allSubtasks.length === 0 || allSubtasks.some((s) => s.status !== 'completed');

        const isStoredStatusValid =
          (storedStatus === calculatedStatus) || // Matches calculated
          (storedStatus === 'human_review' && (calculatedStatus === 'ai_review' || calculatedStatus === 'in_progress')) || // Human review is more advanced than ai_review or in_progress (fixes status loop bug)
          (storedStatus === 'human_review' && isPlanReviewStage) || // Plan review stage (awaiting spec approval)
          (isActiveProcessStatus && storedStatus === 'in_progress' && hasRemainingWork); // Planning/coding phases should show as in_progress ONLY when there's remaining work

        if (isStoredStatusValid) {
          // Preserve reviewReason for human_review status
          if (storedStatus === 'human_review' && !reviewReason) {
            // Infer reason from subtask states or plan review stage
            const hasFailedSubtasks = allSubtasks.some((s) => s.status === 'failed');
            const allCompleted = allSubtasks.length > 0 && allSubtasks.every((s) => s.status === 'completed');
            if (hasFailedSubtasks) {
              reviewReason = 'errors';
            } else if (allCompleted) {
              reviewReason = 'completed';
            } else if (isPlanReviewStage) {
              reviewReason = 'plan_review';
            }
          }
          return { status: storedStatus, reviewReason: storedStatus === 'human_review' ? reviewReason : undefined };
        }
      }
    }

    // SECOND: Check QA report file for additional status info
    const qaReportPath = path.join(specPath, AUTO_BUILD_PATHS.QA_REPORT);
    if (existsSync(qaReportPath)) {
      try {
        const content = readFileSync(qaReportPath, 'utf-8');
        if (content.includes('REJECTED') || content.includes('FAILED')) {
          return { status: 'human_review', reviewReason: 'qa_rejected' };
        }
        if (content.includes('PASSED') || content.includes('APPROVED')) {
          // QA passed - if all subtasks done, move to human_review
          if (allSubtasks.length > 0 && allSubtasks.every((s) => s.status === 'completed')) {
            return { status: 'human_review', reviewReason: 'completed' };
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return { status: calculatedStatus, reviewReason: calculatedStatus === 'human_review' ? reviewReason : undefined };
  }

  /**
   * Validate taskId to prevent path traversal attacks
   * Returns true if taskId is safe to use in path operations
   */
  private isValidTaskId(taskId: string): boolean {
    // Reject empty, null/undefined, or strings with path traversal characters
    if (!taskId || typeof taskId !== 'string') return false;
    if (taskId.includes('/') || taskId.includes('\\')) return false;
    if (taskId === '.' || taskId === '..') return false;
    if (taskId.includes('\0')) return false; // Null byte injection
    return true;
  }

  /**
   * Find ALL spec paths for a task, checking main directory and worktrees
   * A task can exist in multiple locations (main + worktree), so return all paths
   */
  private findAllSpecPaths(projectPath: string, specsBaseDir: string, taskId: string): string[] {
    // Validate taskId to prevent path traversal
    if (!this.isValidTaskId(taskId)) {
      console.error(`[ProjectStore] findAllSpecPaths: Invalid taskId rejected: ${taskId}`);
      return [];
    }

    const paths: string[] = [];

    // 1. Check main specs directory
    const mainSpecPath = path.join(projectPath, specsBaseDir, taskId);
    if (existsSync(mainSpecPath)) {
      paths.push(mainSpecPath);
    }

    // 2. Check worktrees
    const worktreesDir = getTaskWorktreeDir(projectPath);
    if (existsSync(worktreesDir)) {
      try {
        const worktrees = readdirSync(worktreesDir, { withFileTypes: true });
        for (const worktree of worktrees) {
          if (!worktree.isDirectory()) continue;
          const worktreeSpecPath = path.join(worktreesDir, worktree.name, specsBaseDir, taskId);
          if (existsSync(worktreeSpecPath)) {
            paths.push(worktreeSpecPath);
          }
        }
      } catch {
        // Ignore errors reading worktrees
      }
    }

    return paths;
  }

  /**
   * Archive tasks by updating metadata in SQLite database
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to archive
   * @param version - Version they were archived in (optional)
   */
  archiveTasks(projectId: string, taskIds: string[], version?: string): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] archiveTasks: Project not found:', projectId);
      return false;
    }

    const archivedAt = new Date().toISOString();
    let hasErrors = false;

    try {
      const db = getDatabaseConnection().getConnection();

      for (const taskId of taskIds) {
        try {
          // Get current task to update metadata
          const stmt = db.prepare('SELECT metadata_json FROM tasks WHERE id = ? OR spec_id = ?');
          const row = stmt.get(taskId, taskId) as { metadata_json: string } | undefined;

          if (!row) {
            console.log(`[ProjectStore] archiveTasks: Task not found in database for ${taskId}, skipping`);
            continue;
          }

          // Parse and update metadata
          const metadata = JSON.parse(row.metadata_json) as TaskMetadata & Record<string, unknown>;
          metadata.archivedAt = archivedAt;
          if (version) {
            metadata.archivedInVersion = version;
          }

          // Update in database
          const updateStmt = db.prepare('UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ? OR spec_id = ?');
          updateStmt.run(JSON.stringify(metadata), new Date().toISOString(), taskId, taskId);

          console.log(`[ProjectStore] archiveTasks: Successfully archived task ${taskId}`);
        } catch (error) {
          console.error(`[ProjectStore] archiveTasks: Failed to archive task ${taskId}:`, error);
          hasErrors = true;
        }
      }
    } catch (error) {
      console.error('[ProjectStore] archiveTasks: Database error:', error);
      return false;
    }

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }

  /**
   * Unarchive tasks by updating metadata in SQLite database
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to unarchive
   */
  unarchiveTasks(projectId: string, taskIds: string[]): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] unarchiveTasks: Project not found:', projectId);
      return false;
    }

    let hasErrors = false;

    try {
      const db = getDatabaseConnection().getConnection();

      for (const taskId of taskIds) {
        try {
          // Get current task to update metadata
          const stmt = db.prepare('SELECT metadata_json FROM tasks WHERE id = ? OR spec_id = ?');
          const row = stmt.get(taskId, taskId) as { metadata_json: string } | undefined;

          if (!row) {
            console.warn(`[ProjectStore] unarchiveTasks: Task not found in database for ${taskId}`);
            continue;
          }

          // Parse and update metadata (remove archive fields)
          const metadata = JSON.parse(row.metadata_json) as TaskMetadata & Record<string, unknown>;
          delete metadata.archivedAt;
          delete metadata.archivedInVersion;

          // Update in database
          const updateStmt = db.prepare('UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ? OR spec_id = ?');
          updateStmt.run(JSON.stringify(metadata), new Date().toISOString(), taskId, taskId);

          console.log(`[ProjectStore] unarchiveTasks: Successfully unarchived task ${taskId}`);
        } catch (error) {
          console.error(`[ProjectStore] unarchiveTasks: Failed to unarchive task ${taskId}:`, error);
          hasErrors = true;
        }
      }
    } catch (error) {
      console.error('[ProjectStore] unarchiveTasks: Database error:', error);
      return false;
    }

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }
}

// Singleton instance
export const projectStore = new ProjectStore();
