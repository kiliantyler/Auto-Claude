import { EventEmitter } from 'events';
import { getDatabaseConnection } from './database';
import type Database from 'better-sqlite3';

interface DatabaseEvent {
  id: number;
  event_type: 'insert' | 'update' | 'delete';
  entity_id: string;
  entity_type: 'task' | 'project';
  timestamp: string;
}

/**
 * Polls the event_queue table for database changes and emits IPC events.
 * Replaces file watchers for real-time updates with <100ms latency.
 */
export class DatabaseEventPoller extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private lastPollTimestamp: string | null = null;
  private isPolling = false;
  private db: Database.Database | null = null;

  // Prepared statements for better performance
  private getEventsStmt: Database.Statement | null = null;
  private deleteEventsStmt: Database.Statement | null = null;

  /**
   * Start polling the event_queue for new events.
   *
   * @param intervalMs - Polling interval in milliseconds (default: 100ms)
   */
  start(intervalMs: number = 100): void {
    if (this.isPolling) {
      console.warn('[DatabaseEventPoller] Already polling, ignoring start request');
      return;
    }

    try {
      // Get database connection
      const dbConn = getDatabaseConnection();
      this.db = dbConn.getConnection();

      // Prepare statements for efficient polling
      this.getEventsStmt = this.db.prepare(`
        SELECT id, event_type, entity_id, entity_type, timestamp
        FROM event_queue
        WHERE timestamp > ?
        ORDER BY timestamp ASC, id ASC
      `);

      this.deleteEventsStmt = this.db.prepare(`
        DELETE FROM event_queue WHERE id = ?
      `);

      // Initialize last poll timestamp to now
      this.lastPollTimestamp = new Date().toISOString();

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

    // Clean up prepared statements
    if (this.getEventsStmt) {
      // better-sqlite3 statements don't need explicit cleanup
      this.getEventsStmt = null;
    }
    if (this.deleteEventsStmt) {
      this.deleteEventsStmt = null;
    }

    this.db = null;
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
   * Poll the event_queue for new events and emit them.
   * @private
   */
  private poll(): void {
    if (!this.db || !this.getEventsStmt || !this.deleteEventsStmt) {
      return;
    }

    try {
      // Get events since last poll
      const events = this.getEventsStmt.all(
        this.lastPollTimestamp || '1970-01-01T00:00:00.000Z'
      ) as DatabaseEvent[];

      if (events.length === 0) {
        return;
      }

      // Process each event
      for (const event of events) {
        try {
          // Emit IPC event based on entity type and event type
          this.emitIpcEvent(event);

          // Delete processed event from queue
          this.deleteEventsStmt.run(event.id);

          // Update last poll timestamp
          this.lastPollTimestamp = event.timestamp;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit('error', `Failed to process event ${event.id}: ${message}`);
        }
      }

      // Log processed events count
      if (events.length > 0) {
        console.log(`[DatabaseEventPoller] Processed ${events.length} event(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', `Poll failed: ${message}`);
    }
  }

  /**
   * Emit IPC event based on database event type.
   * @private
   */
  private emitIpcEvent(event: DatabaseEvent): void {
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

    // Emit the IPC event with entity ID
    this.emit('event', ipcEventName, entity_id);

    console.log(
      `[DatabaseEventPoller] Emitted ${ipcEventName} for ${entity_type} ${entity_id}`
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
