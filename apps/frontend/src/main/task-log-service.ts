import path from 'path';
import { EventEmitter } from 'events';
import type { TaskLogs, TaskLogPhase, TaskLogStreamChunk, TaskPhaseLog, TaskLogEntry } from '../shared/types';
import { findTaskWorktree } from './worktree-paths';
import { getProjectDatabaseManager } from './database';

function findWorktreeSpecDir(projectPath: string, specId: string, specsRelPath: string): string | null {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    return path.join(worktreePath, specsRelPath, specId);
  }
  return null;
}

/**
 * Extract spec_id from a spec directory path.
 * E.g., /project/.auto-claude/specs/001-feature -> 001-feature
 */
function extractSpecId(specDir: string): string {
  return path.basename(specDir);
}

/**
 * Detect the main project directory from a spec_dir path.
 * Handles both main project and worktree scenarios.
 */
function detectProjectDir(specDir: string): string | null {
  const resolved = path.resolve(specDir);

  // Check if this is a worktree path
  const worktreeMarker = '/.auto-claude/worktrees/';
  if (resolved.includes(worktreeMarker)) {
    // Extract main project path (everything before .auto-claude/worktrees/)
    return resolved.split(worktreeMarker)[0];
  }

  // Standard case: spec_dir is /project/.auto-claude/specs/XXX
  // Go up: XXX -> specs -> .auto-claude -> project
  const parts = resolved.split(path.sep);
  const autoClaudeIndex = parts.indexOf('.auto-claude');
  if (autoClaudeIndex > 0) {
    return parts.slice(0, autoClaudeIndex).join(path.sep);
  }

  return null;
}

/**
 * Service for loading and watching phase-based task logs from SQLite
 *
 * This service provides:
 * - Loading logs from SQLite database (task_logs table)
 * - Watching for log changes via polling
 * - Emitting streaming updates when logs change
 * - Determining which phase is currently active
 *
 * Note: Logs are written by the Python backend to SQLite.
 * This service queries the database and transforms flat rows into
 * the phase-grouped TaskLogs structure expected by the UI.
 */
export class TaskLogService extends EventEmitter {
  private logCache: Map<string, TaskLogs> = new Map();
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();
  private lastLogCounts: Map<string, number> = new Map();
  // Store paths being watched for each specId
  private watchedPaths: Map<string, { mainSpecDir: string; worktreeSpecDir: string | null; specsRelPath: string; projectPath: string }> = new Map();

  // Poll interval for watching log changes
  private readonly POLL_INTERVAL_MS = 1000;

  constructor() {
    super();
  }

  /**
   * Load task logs from SQLite for a specific spec.
   * Returns cached logs if database query fails.
   */
  loadLogsFromPath(specDir: string): TaskLogs | null {
    const specId = extractSpecId(specDir);
    const projectPath = detectProjectDir(specDir);

    if (!projectPath) {
      console.warn(`[TaskLogService] Could not detect project path from: ${specDir}`);
      return this.logCache.get(specDir) || null;
    }

    try {
      const dbManager = getProjectDatabaseManager();
      const conn = dbManager.getConnection(projectPath);
      const db = conn.getConnection();

      // Get task_id for this spec
      const taskRow = db.prepare('SELECT id FROM tasks WHERE spec_id = ?').get(specId) as { id: string } | undefined;
      if (!taskRow) {
        // No task found - return empty structure
        return this.createEmptyLogs(specId);
      }

      const taskId = taskRow.id;

      // Query all logs for this task, ordered by timestamp ascending
      const rows = db.prepare(`
        SELECT id, subtask_id, log_type, message, details_json, agent_name, session_id, timestamp
        FROM task_logs
        WHERE task_id = ?
        ORDER BY timestamp ASC
      `).all(taskId) as Array<{
        id: number;
        subtask_id: string | null;
        log_type: string;
        message: string;
        details_json: string | null;
        agent_name: string | null;
        session_id: string | null;
        timestamp: string;
      }>;

      // Transform rows into TaskLogs structure
      const logs = this.transformRowsToTaskLogs(specId, rows);
      this.logCache.set(specDir, logs);
      return logs;
    } catch (error) {
      // Database error - return cached version if available
      const cached = this.logCache.get(specDir);
      if (cached) {
        return cached;
      }
      console.error(`[TaskLogService] Failed to load logs from database for ${specDir}:`, error);
      return null;
    }
  }

  /**
   * Create an empty TaskLogs structure.
   */
  private createEmptyLogs(specId: string): TaskLogs {
    const now = new Date().toISOString();
    return {
      spec_id: specId,
      created_at: now,
      updated_at: now,
      phases: {
        planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
        coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
        validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
      },
    };
  }

  /**
   * Transform flat database rows into the phase-grouped TaskLogs structure.
   */
  private transformRowsToTaskLogs(specId: string, rows: Array<{
    id: number;
    subtask_id: string | null;
    log_type: string;
    message: string;
    details_json: string | null;
    agent_name: string | null;
    session_id: string | null;
    timestamp: string;
  }>): TaskLogs {
    const now = new Date().toISOString();
    const logs: TaskLogs = {
      spec_id: specId,
      created_at: rows.length > 0 ? rows[0].timestamp : now,
      updated_at: rows.length > 0 ? rows[rows.length - 1].timestamp : now,
      phases: {
        planning: { phase: 'planning', status: 'pending', started_at: null, completed_at: null, entries: [] },
        coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
        validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
      },
    };

    for (const row of rows) {
      let details: Record<string, unknown> = {};
      if (row.details_json) {
        try {
          details = JSON.parse(row.details_json);
        } catch {
          // Invalid JSON - ignore
        }
      }

      // Handle phase status and start log entries (metadata, not displayed)
      if (row.log_type === 'phase_status') {
        const phase = details.phase as TaskLogPhase;
        const status = details.status as string;
        if (phase && logs.phases[phase]) {
          if (status === 'active') {
            logs.phases[phase].status = 'active';
          } else if (status === 'completed') {
            logs.phases[phase].status = 'completed';
            logs.phases[phase].completed_at = (details.completed_at as string) || row.timestamp;
          } else if (status === 'failed') {
            logs.phases[phase].status = 'failed';
            logs.phases[phase].completed_at = row.timestamp;
          }
        }
        continue;
      }

      if (row.log_type === 'phase_start') {
        const phase = details.phase as TaskLogPhase;
        if (phase && logs.phases[phase]) {
          logs.phases[phase].started_at = (details.started_at as string) || row.timestamp;
          if (logs.phases[phase].status === 'pending') {
            logs.phases[phase].status = 'active';
          }
        }
        continue;
      }

      // Regular log entry - add to appropriate phase
      const phase = (details.phase as TaskLogPhase) || 'planning';
      if (!logs.phases[phase]) {
        continue; // Unknown phase
      }

      // Map log_type to TaskLogEntryType
      const entryType = this.mapLogType(row.log_type);

      const entry: TaskLogEntry = {
        timestamp: row.timestamp,
        type: entryType,
        content: row.message,
        phase: phase,
        tool_name: details.tool_name as string | undefined,
        tool_input: details.tool_input as string | undefined,
        subtask_id: row.subtask_id || (details.subtask_id as string | undefined),
        session: details.session as number | undefined,
        // Fields for expandable detail view
        detail: details.detail as string | undefined,
        subphase: details.subphase as string | undefined,
        collapsed: details.collapsed as boolean | undefined,
      };

      logs.phases[phase].entries.push(entry);
    }

    return logs;
  }

  /**
   * Map backend log_type to frontend TaskLogEntryType.
   */
  private mapLogType(logType: string): TaskLogEntry['type'] {
    switch (logType) {
      case 'tool':
      case 'tool_start':
        return 'tool_start';
      case 'tool_end':
        return 'tool_end';
      case 'error':
        return 'error';
      case 'success':
        return 'success';
      case 'info':
        return 'info';
      case 'agent':
        return 'text';
      case 'warning':
        return 'info';
      case 'debug':
        return 'info';
      default:
        return 'text';
    }
  }

  /**
   * Merge logs from main and worktree spec directories.
   */
  private mergeLogs(mainLogs: TaskLogs | null, worktreeLogs: TaskLogs | null, specDir: string): TaskLogs | null {
    if (!worktreeLogs) {
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    if (!mainLogs) {
      this.logCache.set(specDir, worktreeLogs);
      return worktreeLogs;
    }

    // Merge logs: planning from main, coding/validation from worktree (if available)
    const mergedLogs: TaskLogs = {
      spec_id: mainLogs.spec_id,
      created_at: mainLogs.created_at,
      updated_at: worktreeLogs.updated_at > mainLogs.updated_at ? worktreeLogs.updated_at : mainLogs.updated_at,
      phases: {
        planning: mainLogs.phases.planning || worktreeLogs.phases.planning,
        // Use worktree logs for coding/validation if they have entries, otherwise fall back to main
        coding: (worktreeLogs.phases.coding?.entries?.length > 0 || worktreeLogs.phases.coding?.status !== 'pending')
          ? worktreeLogs.phases.coding
          : mainLogs.phases.coding,
        validation: (worktreeLogs.phases.validation?.entries?.length > 0 || worktreeLogs.phases.validation?.status !== 'pending')
          ? worktreeLogs.phases.validation
          : mainLogs.phases.validation
      }
    };

    this.logCache.set(specDir, mergedLogs);
    return mergedLogs;
  }

  /**
   * Load and merge task logs from main spec dir and worktree spec dir.
   * Planning phase logs are in main spec dir, coding/validation logs may be in worktree.
   *
   * @param specDir - Main project spec directory
   * @param projectPath - Optional: Project root path (needed to find worktree if not registered)
   * @param specsRelPath - Optional: Relative path to specs (e.g., "auto-claude/specs")
   * @param specId - Optional: Spec ID (needed to find worktree if not registered)
   */
  loadLogs(specDir: string, projectPath?: string, specsRelPath?: string, specId?: string): TaskLogs | null {
    // First try to load from main spec dir
    const mainLogs = this.loadLogsFromPath(specDir);

    // Check if we have worktree paths registered for this spec
    const watchedInfo = Array.from(this.watchedPaths.entries()).find(
      ([_, info]) => info.mainSpecDir === specDir
    );

    let worktreeSpecDir: string | null = null;

    if (watchedInfo && watchedInfo[1].worktreeSpecDir) {
      worktreeSpecDir = watchedInfo[1].worktreeSpecDir;
    } else if (projectPath && specsRelPath && specId) {
      // Calculate worktree path from provided params
      worktreeSpecDir = findWorktreeSpecDir(projectPath, specId, specsRelPath);
    }

    if (!worktreeSpecDir) {
      // No worktree info available
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    // Try to load from worktree spec dir
    const worktreeLogs = this.loadLogsFromPath(worktreeSpecDir);

    return this.mergeLogs(mainLogs, worktreeLogs, specDir);
  }

  /**
   * Get the currently active phase from logs.
   */
  getActivePhase(specDir: string): TaskLogPhase | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;

    const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];
    for (const phase of phases) {
      if (logs.phases[phase]?.status === 'active') {
        return phase;
      }
    }
    return null;
  }

  /**
   * Get logs for a specific phase.
   */
  getPhaseLog(specDir: string, phase: TaskLogPhase): TaskPhaseLog | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;
    return logs.phases[phase] || null;
  }

  /**
   * Start watching a spec directory for log changes.
   * Polls the SQLite database for new log entries.
   *
   * @param specId - The spec ID (e.g., "013-screenshots-on-tasks")
   * @param specDir - Main project spec directory
   * @param projectPath - Optional: Project root path (needed to find worktree)
   * @param specsRelPath - Optional: Relative path to specs (e.g., "auto-claude/specs")
   */
  startWatching(specId: string, specDir: string, projectPath?: string, specsRelPath?: string): void {
    // Check if already watching with the same parameters (prevents rapid watch/unwatch cycles)
    const existingWatch = this.watchedPaths.get(specId);
    if (existingWatch && existingWatch.mainSpecDir === specDir) {
      // Already watching this spec with the same spec directory - no-op
      return;
    }

    // Stop any existing watch (different spec dir or first time)
    this.stopWatching(specId);

    // Detect project path if not provided
    const resolvedProjectPath = projectPath || detectProjectDir(specDir);
    if (!resolvedProjectPath) {
      console.warn(`[TaskLogService] Cannot start watching - no project path for: ${specDir}`);
      return;
    }

    // Calculate worktree spec directory path if we have project info
    let worktreeSpecDir: string | null = null;
    if (resolvedProjectPath && specsRelPath) {
      worktreeSpecDir = findWorktreeSpecDir(resolvedProjectPath, specId, specsRelPath);
    }

    // Store watched paths for this specId
    this.watchedPaths.set(specId, {
      mainSpecDir: specDir,
      worktreeSpecDir,
      specsRelPath: specsRelPath || '',
      projectPath: resolvedProjectPath
    });

    // Do initial load
    const initialLogs = this.loadLogs(specDir);
    if (initialLogs) {
      this.logCache.set(specDir, initialLogs);
      // Store initial entry count
      const totalEntries = this.countTotalEntries(initialLogs);
      this.lastLogCounts.set(specId, totalEntries);
    }

    // Poll for changes in the database
    const pollInterval = setInterval(() => {
      // Dynamically re-discover worktree if not found yet
      const watchedInfo = this.watchedPaths.get(specId);
      let currentWorktreeSpecDir = watchedInfo?.worktreeSpecDir || null;

      if (!currentWorktreeSpecDir && resolvedProjectPath && specsRelPath) {
        const discoveredWorktree = findWorktreeSpecDir(resolvedProjectPath, specId, specsRelPath);
        if (discoveredWorktree) {
          currentWorktreeSpecDir = discoveredWorktree;
          // Update stored paths so future iterations don't need to re-discover
          this.watchedPaths.set(specId, {
            mainSpecDir: specDir,
            worktreeSpecDir: discoveredWorktree,
            specsRelPath: specsRelPath,
            projectPath: resolvedProjectPath
          });
          console.warn(`[TaskLogService] Discovered worktree for ${specId}: ${discoveredWorktree}`);
        }
      }

      // Load current logs from database
      const previousLogs = this.logCache.get(specDir);
      const previousCount = this.lastLogCounts.get(specId) || 0;

      const logs = this.loadLogs(specDir);

      if (logs) {
        const currentCount = this.countTotalEntries(logs);

        // Check if logs changed
        if (currentCount !== previousCount) {
          this.lastLogCounts.set(specId, currentCount);

          // Emit change event with the logs
          this.emit('logs-changed', specId, logs);

          // Calculate and emit streaming updates for new entries
          this.emitNewEntries(specId, previousLogs, logs);
        }
      }
    }, this.POLL_INTERVAL_MS);

    this.pollIntervals.set(specId, pollInterval);
    console.warn(`[TaskLogService] Started watching ${specId} (project: ${resolvedProjectPath}${worktreeSpecDir ? `, worktree: ${worktreeSpecDir}` : ''})`);
  }

  /**
   * Count total entries across all phases.
   */
  private countTotalEntries(logs: TaskLogs): number {
    return (
      (logs.phases.planning?.entries?.length || 0) +
      (logs.phases.coding?.entries?.length || 0) +
      (logs.phases.validation?.entries?.length || 0)
    );
  }

  /**
   * Stop watching a spec directory.
   */
  stopWatching(specId: string): void {
    const interval = this.pollIntervals.get(specId);
    if (interval) {
      clearInterval(interval);
      this.pollIntervals.delete(specId);
      this.watchedPaths.delete(specId);
      this.lastLogCounts.delete(specId);
      console.warn(`[TaskLogService] Stopped watching ${specId}`);
    }
  }

  /**
   * Stop all watches.
   */
  stopAllWatching(): void {
    for (const specId of this.pollIntervals.keys()) {
      this.stopWatching(specId);
    }
  }

  /**
   * Emit streaming updates for new log entries.
   */
  private emitNewEntries(specId: string, previousLogs: TaskLogs | undefined, currentLogs: TaskLogs): void {
    const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];

    for (const phase of phases) {
      const prevPhase = previousLogs?.phases[phase];
      const currPhase = currentLogs.phases[phase];

      if (!currPhase) continue;

      // Check for phase status changes
      if (prevPhase?.status !== currPhase.status) {
        if (currPhase.status === 'active') {
          this.emit('stream-chunk', specId, {
            type: 'phase_start',
            phase,
            timestamp: currPhase.started_at || new Date().toISOString()
          } as TaskLogStreamChunk);
        } else if (currPhase.status === 'completed' || currPhase.status === 'failed') {
          this.emit('stream-chunk', specId, {
            type: 'phase_end',
            phase,
            timestamp: currPhase.completed_at || new Date().toISOString()
          } as TaskLogStreamChunk);
        }
      }

      // Check for new entries
      const prevEntryCount = prevPhase?.entries.length || 0;
      const currEntryCount = currPhase.entries.length;

      if (currEntryCount > prevEntryCount) {
        // Emit new entries
        for (let i = prevEntryCount; i < currEntryCount; i++) {
          const entry = currPhase.entries[i];

          const streamUpdate: TaskLogStreamChunk = {
            type: entry.type as TaskLogStreamChunk['type'],
            content: entry.content,
            phase: entry.phase,
            timestamp: entry.timestamp,
            subtask_id: entry.subtask_id
          };

          if (entry.tool_name) {
            streamUpdate.tool = {
              name: entry.tool_name,
              input: entry.tool_input
            };
          }

          this.emit('stream-chunk', specId, streamUpdate);
        }
      }
    }
  }

  /**
   * Get cached logs without re-reading from database.
   */
  getCachedLogs(specDir: string): TaskLogs | null {
    return this.logCache.get(specDir) || null;
  }

  /**
   * Clear the log cache for a spec.
   */
  clearCache(specDir: string): void {
    this.logCache.delete(specDir);
  }

  /**
   * Check if logs exist for a spec (always true if task exists in database).
   */
  hasLogs(specDir: string): boolean {
    const specId = extractSpecId(specDir);
    const projectPath = detectProjectDir(specDir);

    if (!projectPath) {
      return false;
    }

    try {
      const dbManager = getProjectDatabaseManager();
      const conn = dbManager.getConnection(projectPath);
      const db = conn.getConnection();

      const row = db.prepare('SELECT id FROM tasks WHERE spec_id = ?').get(specId) as { id: string } | undefined;
      return !!row;
    } catch {
      return false;
    }
  }
}

// Singleton instance
export const taskLogService = new TaskLogService();
