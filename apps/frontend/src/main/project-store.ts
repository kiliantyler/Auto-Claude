import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, Dirent } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project, ProjectSettings, Task, TaskStatus, TaskMetadata, ImplementationPlan, ReviewReason, PlanSubtask, ExecutionPhase } from '../shared/types';
import { DEFAULT_PROJECT_SETTINGS, AUTO_BUILD_PATHS, getSpecsDir } from '../shared/constants';
import { getAutoBuildPath, isInitialized } from './project-initializer';
import { getTaskWorktreeDir } from './worktree-paths';
import { getDatabaseConnection } from './database';

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

    // Enable dual-write by default (Phase 1 migration strategy)
    // Set ENABLE_DUAL_WRITE=false to use SQLite-only mode
    this.ENABLE_DUAL_WRITE = process.env.ENABLE_DUAL_WRITE !== 'false';
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

        // Dual-write: Update both JSON and database
        if (this.ENABLE_DUAL_WRITE) {
          this.save();
          this.writeProjectToDatabase(existing);
        } else {
          this.save();
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

    // Dual-write: Write to both JSON and database
    this.data.projects.push(project);
    if (this.ENABLE_DUAL_WRITE) {
      this.save();
      this.writeProjectToDatabase(project);
    } else {
      this.save();
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

      // Dual-write: Update both JSON and database
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.writeProjectToDatabase(project);
      } else {
        this.save();
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

      // Dual-write: Delete from both JSON and database
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.deleteProjectFromDatabase(projectId);
      } else {
        this.save();
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
      // Dual-write: Update both JSON and database
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        // Update all modified projects in database
        for (const projectId of resetProjectIds) {
          const project = this.data.projects.find((p) => p.id === projectId);
          if (project) {
            this.writeProjectToDatabase(project);
          }
        }
      } else {
        this.save();
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

      // Dual-write: Update both JSON and database
      if (this.ENABLE_DUAL_WRITE) {
        this.save();
        this.writeProjectToDatabase(project);
      } else {
        this.save();
      }
    }
    return project;
  }

  /**
   * Get tasks for a project by scanning specs directory
   * Implements caching with 3-second TTL to prevent excessive worktree scanning
   */
  getTasks(projectId: string): Task[] {
    // Check cache first
    const cached = this.tasksCache.get(projectId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
      console.debug('[ProjectStore] Returning cached tasks for project:', projectId, '(age:', now - cached.timestamp, 'ms)');
      return cached.tasks;
    }

    console.warn('[ProjectStore] getTasks called with projectId:', projectId, cached ? '(cache expired)' : '(cache miss)');
    const project = this.getProject(projectId);
    if (!project) {
      console.warn('[ProjectStore] Project not found for id:', projectId);
      return [];
    }
    console.warn('[ProjectStore] Found project:', project.name, 'autoBuildPath:', project.autoBuildPath);

    const allTasks: Task[] = [];
    const specsBaseDir = getSpecsDir(project.autoBuildPath);

    // 1. Scan main project specs directory (source of truth for task existence)
    const mainSpecsDir = path.join(project.path, specsBaseDir);
    const mainSpecIds = new Set<string>();
    console.warn('[ProjectStore] Main specsDir:', mainSpecsDir, 'exists:', existsSync(mainSpecsDir));
    if (existsSync(mainSpecsDir)) {
      const mainTasks = this.loadTasksFromSpecsDir(mainSpecsDir, project.path, 'main', projectId, specsBaseDir);
      allTasks.push(...mainTasks);
      // Track which specs exist in main project
      mainTasks.forEach(t => mainSpecIds.add(t.specId));
      console.warn('[ProjectStore] Loaded', mainTasks.length, 'tasks from main project');
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
    console.warn('[ProjectStore] Returning', tasks.length, 'unique tasks (after deduplication)');

    // Update cache
    this.tasksCache.set(projectId, { tasks, timestamp: now });

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
   * Load tasks from a specs directory (helper method for main project and worktrees)
   */
  private loadTasksFromSpecsDir(
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
   * Archive tasks by writing archivedAt to their metadata
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

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const archivedAt = new Date().toISOString();
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = this.findAllSpecPaths(project.path, specsBaseDir, taskId);

      // If spec directory doesn't exist anywhere, skip gracefully
      if (specPaths.length === 0) {
        console.log(`[ProjectStore] archiveTasks: Spec directory not found for ${taskId}, skipping (already removed)`);
        continue;
      }

      // Archive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata = {};

          // Read existing metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            // File doesn't exist yet - start with empty metadata
            if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw readErr;
            }
          }

          // Add archive info
          metadata.archivedAt = archivedAt;
          if (version) {
            metadata.archivedInVersion = version;
          }

          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log(`[ProjectStore] archiveTasks: Successfully archived task ${taskId} at ${specPath}`);
        } catch (error) {
          console.error(`[ProjectStore] archiveTasks: Failed to archive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }

  /**
   * Unarchive tasks by removing archivedAt from their metadata
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to unarchive
   */
  unarchiveTasks(projectId: string, taskIds: string[]): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] unarchiveTasks: Project not found:', projectId);
      return false;
    }

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = this.findAllSpecPaths(project.path, specsBaseDir, taskId);

      if (specPaths.length === 0) {
        console.warn(`[ProjectStore] unarchiveTasks: Spec directory not found for task ${taskId}`);
        continue;
      }

      // Unarchive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata;

          // Read metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
              console.warn(`[ProjectStore] unarchiveTasks: Metadata file not found for task ${taskId} at ${specPath}`);
              continue;
            }
            throw readErr;
          }

          delete metadata.archivedAt;
          delete metadata.archivedInVersion;
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log(`[ProjectStore] unarchiveTasks: Successfully unarchived task ${taskId} at ${specPath}`);
        } catch (error) {
          console.error(`[ProjectStore] unarchiveTasks: Failed to unarchive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }
}

// Singleton instance
export const projectStore = new ProjectStore();
