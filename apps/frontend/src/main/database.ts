/**
 * SQLite Database Connection Management
 * ======================================
 *
 * Provides connection management for better-sqlite3 with transaction support.
 *
 * Key Features:
 * - Synchronous API (better-sqlite3 doesn't use async/await)
 * - Automatic transaction management
 * - Safe connection lifecycle management
 * - Database file stored in userData/.auto-claude/tasks.db
 *
 * Usage:
 * ```typescript
 * const dbConn = new DatabaseConnection();
 * const db = dbConn.getConnection();
 *
 * // Execute queries
 * const result = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
 *
 * // Use transactions
 * dbConn.withTransaction(() => {
 *   db.prepare('INSERT INTO tasks ...').run(...);
 *   db.prepare('UPDATE metadata ...').run(...);
 * });
 * ```
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { logSqliteFeatures, checkCompileOption } from './utils/sqlite-features';

export class DatabaseConnection {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    // Default to userData/.auto-claude/tasks.db
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      const userDataPath = app.getPath('userData');
      const autoClaudeDir = path.join(userDataPath, '.auto-claude');

      // Ensure directory exists
      if (!existsSync(autoClaudeDir)) {
        mkdirSync(autoClaudeDir, { recursive: true });
      }

      this.dbPath = path.join(autoClaudeDir, 'tasks.db');
    }
  }

  /**
   * Get or create database connection.
   *
   * Connection is created on first access and reused for subsequent calls.
   * Better-sqlite3 uses synchronous API - no async/await needed.
   *
   * @returns SQLite database connection
   */
  getConnection(): Database.Database {
    if (!this.db) {
      // Create connection with safe defaults
      this.db = new Database(this.dbPath, {
        // Verbose mode logs SQL statements (useful for debugging)
        // verbose: console.log,
      });

      // Enable foreign key constraints
      this.db.pragma('foreign_keys = ON');

      // Use WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Set synchronous mode to NORMAL for good balance of safety and performance
      this.db.pragma('synchronous = NORMAL');

      // Log SQLite features (including FTS5 status) for debugging
      logSqliteFeatures(this.db);

      // Verify FTS5 is available (required for Phase 4B full-text search)
      const fts5Enabled = checkCompileOption(this.db, 'ENABLE_FTS5');
      if (!fts5Enabled) {
        console.warn(
          '[Database] WARNING: FTS5 is not enabled. Full-text search features will not work. ' +
            'Try running: npm run rebuild'
        );
      }

      console.log(`[Database] Initialized SQLite database at: ${this.dbPath}`);
    }

    return this.db;
  }

  /**
   * Execute a function within a transaction.
   *
   * Automatically handles commit on success and rollback on error.
   * CRITICAL: Do NOT use async/await inside the callback - better-sqlite3
   * will commit the transaction before awaits complete.
   *
   * @param fn - Function to execute within transaction (must be synchronous)
   * @returns Result of the function
   *
   * @example
   * ```typescript
   * dbConn.withTransaction(() => {
   *   db.prepare('INSERT INTO tasks ...').run(...);
   *   db.prepare('UPDATE metadata ...').run(...);
   * });
   * ```
   */
  withTransaction<T>(fn: () => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction();
  }

  /**
   * Close the database connection.
   *
   * Should be called on app shutdown to ensure clean exit.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[Database] Connection closed');
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }
}

// Singleton instance for the main database
let _instance: DatabaseConnection | null = null;

/**
 * Get the singleton database connection instance.
 *
 * @returns DatabaseConnection instance
 */
export function getDatabaseConnection(): DatabaseConnection {
  if (!_instance) {
    _instance = new DatabaseConnection();
  }
  return _instance;
}

/**
 * Close the singleton database connection.
 * Call this on app shutdown.
 */
export function closeDatabaseConnection(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
