import { EventEmitter } from 'events';
import { getGlobalDatabase, getProjectDatabaseManager } from './database';
import { projectStore } from './project-store';
import type Database from 'better-sqlite3';

interface DatabaseEvent {
  id: number;
  event_type: 'insert' | 'update' | 'delete';
  entity_id: string;
  entity_type: 'task' | 'project';
  timestamp: string;
}

interface ProjectPoller {
  projectId: string;
  projectPath: string;
  getEventsStmt: Database.Statement;
  deleteEventsStmt: Database.Statement;
  lastPollTimestamp: string;
}

/**
 * Polls the event_queue tables from both global and project-local databases.
 *
 * Dual-Database Polling:
 * - Global database (app.db): Polls for project events (insert/update/delete)
 * - Project-local databases (tasks.db): Polls for task events in each active project
 *
 * Replaces file watchers for real-time updates with <100ms latency.
 */
export class DatabaseEventPoller extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  // Global database poller state
  private globalDb: Database.Database | null = null;
  private globalGetEventsStmt: Database.Statement | null = null;
  private globalDeleteEventsStmt: Database.Statement | null = null;
  private globalLastPollTimestamp: string | null = null;

  // Project-local database pollers (one per active project)
  private projectPollers: Map<string, ProjectPoller> = new Map();

  /**
   * Start polling both global and project-local databases for events.
   *
   * @param intervalMs - Polling interval in milliseconds (default: 100ms)
   */
  start(intervalMs: number = 100): void {
    if (this.isPolling) {
      console.warn('[DatabaseEventPoller] Already polling, ignoring start request');
      return;
    }

    try {
      // Initialize global database poller
      this.initGlobalPoller();

      // Initialize project-local pollers for all registered projects
      this.initProjectPollers();

      // Initialize last poll timestamp to now
      this.globalLastPollTimestamp = new Date().toISOString();

      this.isPolling = true;
      console.log(`[DatabaseEventPoller] Started polling every ${intervalMs}ms`);

      // Start polling
      this.pollInterval = setInterval(() => {
        this.poll();
      }, intervalMs);

      // Do an initial poll immediately
      this.poll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', `Failed to start poller: ${message}`);
    }
  }

  /**
   * Initialize the global database poller for project events.
   * @private
   */
  private initGlobalPoller(): void {
    const dbConn = getGlobalDatabase();
    this.globalDb = dbConn.getConnection();

    this.globalGetEventsStmt = this.globalDb.prepare(`
      SELECT id, event_type, entity_id, entity_type, timestamp
      FROM event_queue
      WHERE timestamp > ?
      ORDER BY timestamp ASC, id ASC
    `);

    this.globalDeleteEventsStmt = this.globalDb.prepare(`
      DELETE FROM event_queue WHERE id = ?
    `);

    console.log('[DatabaseEventPoller] Initialized global database poller');
  }

  /**
   * Initialize project-local pollers for all registered projects.
   * @private
   */
  private initProjectPollers(): void {
    const projects = projectStore.getProjects();

    for (const project of projects) {
      this.addProjectPoller(project.id, project.path);
    }

    console.log(`[DatabaseEventPoller] Initialized ${this.projectPollers.size} project poller(s)`);
  }

  /**
   * Add a poller for a specific project.
   * Called when a new project is added or when starting polling.
   *
   * @param projectId - Project ID
   * @param projectPath - Path to the project directory
   */
  addProjectPoller(projectId: string, projectPath: string): void {
    if (this.projectPollers.has(projectId)) {
      return; // Already polling this project
    }

    try {
      const dbManager = getProjectDatabaseManager();

      // Check if database exists for this project
      if (!dbManager.hasDatabase(projectPath)) {
        console.log(`[DatabaseEventPoller] No database found for project ${projectId}, skipping`);
        return;
      }

      const conn = dbManager.getConnection(projectPath);
      const db = conn.getConnection();

      const getEventsStmt = db.prepare(`
        SELECT id, event_type, entity_id, entity_type, timestamp
        FROM event_queue
        WHERE timestamp > ?
        ORDER BY timestamp ASC, id ASC
      `);

      const deleteEventsStmt = db.prepare(`
        DELETE FROM event_queue WHERE id = ?
      `);

      this.projectPollers.set(projectId, {
        projectId,
        projectPath,
        getEventsStmt,
        deleteEventsStmt,
        lastPollTimestamp: new Date().toISOString(),
      });

      console.log(`[DatabaseEventPoller] Added poller for project ${projectId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DatabaseEventPoller] Failed to add poller for project ${projectId}: ${message}`);
    }
  }

  /**
   * Remove a poller for a specific project.
   * Called when a project is removed or closed.
   *
   * @param projectId - Project ID to remove poller for
   */
  removeProjectPoller(projectId: string): void {
    if (this.projectPollers.has(projectId)) {
      this.projectPollers.delete(projectId);
      console.log(`[DatabaseEventPoller] Removed poller for project ${projectId}`);
    }
  }

  /**
   * Stop polling the event_queue.
   */
  stop(): void {
    if (!this.isPolling) {
      return;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Clean up global poller
    this.globalGetEventsStmt = null;
    this.globalDeleteEventsStmt = null;
    this.globalDb = null;

    // Clean up project pollers
    this.projectPollers.clear();

    this.isPolling = false;
    console.log('[DatabaseEventPoller] Stopped polling');
  }

  /**
   * Check if the poller is currently running.
   */
  isRunning(): boolean {
    return this.isPolling;
  }

  /**
   * Poll all databases for new events and emit them.
   * @private
   */
  private poll(): void {
    // Poll global database for project events
    this.pollGlobalDatabase();

    // Poll each project database for task events
    this.pollProjectDatabases();
  }

  /**
   * Poll the global database for project events.
   * @private
   */
  private pollGlobalDatabase(): void {
    if (!this.globalDb || !this.globalGetEventsStmt || !this.globalDeleteEventsStmt) {
      return;
    }

    try {
      const events = this.globalGetEventsStmt.all(
        this.globalLastPollTimestamp || '1970-01-01T00:00:00.000Z'
      ) as DatabaseEvent[];

      if (events.length === 0) {
        return;
      }

      for (const event of events) {
        try {
          // Only process project events from global database
          if (event.entity_type === 'project') {
            this.emitIpcEvent(event);
          }

          // Delete processed event from queue
          this.globalDeleteEventsStmt.run(event.id);

          // Update last poll timestamp
          this.globalLastPollTimestamp = event.timestamp;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', `Failed to process global event ${event.id}: ${message}`);
        }
      }

      if (events.length > 0) {
        console.log(`[DatabaseEventPoller] Processed ${events.length} global event(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', `Global poll failed: ${message}`);
    }
  }

  /**
   * Poll all project databases for task events.
   * @private
   */
  private pollProjectDatabases(): void {
    for (const [projectId, poller] of this.projectPollers) {
      try {
        const events = poller.getEventsStmt.all(
          poller.lastPollTimestamp || '1970-01-01T00:00:00.000Z'
        ) as DatabaseEvent[];

        if (events.length === 0) {
          continue;
        }

        for (const event of events) {
          try {
            // Only process task events from project databases
            if (event.entity_type === 'task') {
              this.emitIpcEvent(event, projectId);
            }

            // Delete processed event from queue
            poller.deleteEventsStmt.run(event.id);

            // Update last poll timestamp
            poller.lastPollTimestamp = event.timestamp;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.emit('error', `Failed to process project event ${event.id}: ${message}`);
          }
        }

        if (events.length > 0) {
          console.log(`[DatabaseEventPoller] Processed ${events.length} event(s) from project ${projectId}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', `Poll failed for project ${projectId}: ${message}`);
      }
    }
  }

  /**
   * Emit IPC event based on database event type.
   * @private
   * @param event - The database event
   * @param projectId - Optional project ID for task events
   */
  private emitIpcEvent(event: DatabaseEvent, projectId?: string): void {
    const { event_type, entity_id, entity_type } = event;

    // Map database event types to IPC event names
    let ipcEventName: string;

    if (entity_type === 'task') {
      switch (event_type) {
        case 'insert':
          ipcEventName = 'db:task:created';
          break;
        case 'update':
          ipcEventName = 'db:task:updated';
          break;
        case 'delete':
          ipcEventName = 'db:task:deleted';
          break;
        default:
          console.warn(`[DatabaseEventPoller] Unknown event type: ${event_type}`);
          return;
      }
    } else if (entity_type === 'project') {
      switch (event_type) {
        case 'insert':
          ipcEventName = 'db:project:created';
          break;
        case 'update':
          ipcEventName = 'db:project:updated';
          break;
        case 'delete':
          ipcEventName = 'db:project:deleted';
          break;
        default:
          console.warn(`[DatabaseEventPoller] Unknown event type: ${event_type}`);
          return;
      }
    } else {
      console.warn(`[DatabaseEventPoller] Unknown entity type: ${entity_type}`);
      return;
    }

    // Emit the IPC event with entity ID and optional project ID
    if (projectId) {
      this.emit('event', ipcEventName, entity_id, projectId);
    } else {
      this.emit('event', ipcEventName, entity_id);
    }

    console.log(
      `[DatabaseEventPoller] Emitted ${ipcEventName} for ${entity_type} ${entity_id}${projectId ? ` in project ${projectId}` : ''}`
    );
  }
}

// Singleton instance
let _pollerInstance: DatabaseEventPoller | null = null;

/**
 * Get the singleton database event poller instance.
 *
 * @returns DatabaseEventPoller instance
 */
export function getDatabaseEventPoller(): DatabaseEventPoller {
  if (!_pollerInstance) {
    _pollerInstance = new DatabaseEventPoller();
  }
  return _pollerInstance;
}

/**
 * Stop and clean up the singleton database event poller.
 * Call this on app shutdown.
 */
export function stopDatabaseEventPoller(): void {
  if (_pollerInstance) {
    _pollerInstance.stop();
    _pollerInstance = null;
  }
}
