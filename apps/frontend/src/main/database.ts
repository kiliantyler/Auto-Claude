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
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { logSqliteFeatures, checkCompileOption } from './utils/sqlite-features';

/**
 * Current schema version - update when adding new migrations
 * Version 003: Phase 4 tables (task_history, tasks_fts, undo_stack, task_metrics)
 */
const CURRENT_SCHEMA_VERSION = '003';

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

  /**
   * Get the current schema version from the metadata table.
   *
   * Returns null if the metadata table doesn't exist or version is not set.
   *
   * @returns Current schema version or null
   */
  getSchemaVersion(): string | null {
    const db = this.getConnection();

    try {
      // Check if metadata table exists
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
        .get() as { name: string } | undefined;

      if (!tableCheck) {
        return null;
      }

      // Get schema version from metadata
      const result = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;

      return result?.value || null;
    } catch (error) {
      console.error('[Database] Error getting schema version:', error);
      return null;
    }
  }

  /**
   * Check if the database needs migration.
   *
   * Returns true if the current schema version is older than the expected version
   * or if the schema hasn't been initialized yet.
   *
   * @returns true if migration is needed
   */
  needsMigration(): boolean {
    const currentVersion = this.getSchemaVersion();

    if (!currentVersion) {
      console.log('[Database] No schema version found - migration needed');
      return true;
    }

    const needsUpdate = currentVersion < CURRENT_SCHEMA_VERSION;
    if (needsUpdate) {
      console.log(
        `[Database] Schema version ${currentVersion} is older than ${CURRENT_SCHEMA_VERSION} - migration needed`
      );
    }

    return needsUpdate;
  }

  /**
   * Initialize the database schema by executing the SQL schema file.
   *
   * This method:
   * 1. Reads the database-schema.sql file
   * 2. Executes all CREATE TABLE, CREATE INDEX, and CREATE TRIGGER statements
   * 3. Updates the schema version in metadata
   *
   * Safe to call multiple times - uses IF NOT EXISTS for all DDL.
   *
   * @param schemaPath - Optional custom path to schema file (for testing)
   * @returns true if initialization succeeded
   */
  initializeSchema(schemaPath?: string): boolean {
    const db = this.getConnection();

    try {
      // Determine schema file path
      const resolvedSchemaPath =
        schemaPath ||
        path.join(__dirname, 'database-schema.sql');

      // Check if schema file exists
      if (!existsSync(resolvedSchemaPath)) {
        console.error(`[Database] Schema file not found: ${resolvedSchemaPath}`);
        return false;
      }

      // Read and execute schema file
      console.log(`[Database] Initializing schema from: ${resolvedSchemaPath}`);
      const schemaSQL = readFileSync(resolvedSchemaPath, 'utf-8');

      // Execute all statements in the schema file
      // Note: better-sqlite3's exec() handles multiple statements
      db.exec(schemaSQL);

      // Update last migration timestamp
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_migration', datetime('now'))").run();

      console.log(`[Database] Schema initialized successfully (version ${CURRENT_SCHEMA_VERSION})`);
      return true;
    } catch (error) {
      console.error('[Database] Failed to initialize schema:', error);
      return false;
    }
  }

  /**
   * Run schema migration if needed.
   *
   * This method checks the current schema version and runs initializeSchema()
   * if the database needs to be updated. It's safe to call on every app startup.
   *
   * @param schemaPath - Optional custom path to schema file (for testing)
   * @returns true if database is up to date (either was already current or migration succeeded)
   */
  migrateIfNeeded(schemaPath?: string): boolean {
    if (this.needsMigration()) {
      console.log('[Database] Running schema migration...');
      return this.initializeSchema(schemaPath);
    }

    console.log(`[Database] Schema is up to date (version ${this.getSchemaVersion()})`);
    return true;
  }

  /**
   * Rebuild the FTS5 index from the tasks table.
   *
   * Use this method if the FTS index becomes corrupted or out of sync.
   * This will delete all FTS data and re-populate from the tasks table.
   *
   * @returns true if rebuild succeeded
   */
  rebuildFtsIndex(): boolean {
    const db = this.getConnection();

    try {
      console.log('[Database] Rebuilding FTS5 index...');

      // Use a transaction to ensure atomicity
      const transaction = db.transaction(() => {
        // Delete all FTS data using the 'delete-all' command
        db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')");

        // Re-populate FTS index from tasks table
        db.exec(`
          INSERT INTO tasks_fts(rowid, title, description, tags)
          SELECT rowid, title, description, json_extract(metadata_json, '$.tags')
          FROM tasks
        `);
      });

      transaction();

      console.log('[Database] FTS5 index rebuilt successfully');
      return true;
    } catch (error) {
      console.error('[Database] Failed to rebuild FTS index:', error);
      return false;
    }
  }

  /**
   * Check if all Phase 4 tables exist in the database.
   *
   * Useful for verifying the schema was created correctly.
   *
   * @returns Object with table existence status
   */
  checkPhase4Tables(): {
    taskHistory: boolean;
    tasksFts: boolean;
    undoStack: boolean;
    taskMetrics: boolean;
  } {
    const db = this.getConnection();

    const checkTable = (tableName: string): boolean => {
      try {
        const result = db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
          .get(tableName) as { name: string } | undefined;
        return !!result;
      } catch {
        return false;
      }
    };

    return {
      taskHistory: checkTable('task_history'),
      tasksFts: checkTable('tasks_fts'),
      undoStack: checkTable('undo_stack'),
      taskMetrics: checkTable('task_metrics'),
    };
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

/**
 * Initialize database schema using the singleton connection.
 *
 * Convenience function that calls migrateIfNeeded() on the singleton instance.
 * Safe to call on every app startup - will only migrate if needed.
 *
 * @param schemaPath - Optional custom path to schema file (for testing)
 * @returns true if database is ready (schema is up to date)
 */
export function initializeDatabaseSchema(schemaPath?: string): boolean {
  return getDatabaseConnection().migrateIfNeeded(schemaPath);
}

/**
 * Get the current schema version constant.
 *
 * @returns Expected schema version string
 */
export function getExpectedSchemaVersion(): string {
  return CURRENT_SCHEMA_VERSION;
}
