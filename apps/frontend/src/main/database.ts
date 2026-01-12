/**
 * SQLite Database Connection Management
 * ======================================
 *
 * Dual-Database Architecture:
 * - GLOBAL database: userData/.auto-claude/app.db (projects registry)
 * - PROJECT-LOCAL databases: <project>/.auto-claude/tasks.db (tasks, insights, etc.)
 *
 * Key Features:
 * - Synchronous API (better-sqlite3 doesn't use async/await)
 * - Automatic transaction management
 * - Safe connection lifecycle management
 * - Separate schemas for global vs project-local data
 *
 * Usage:
 * ```typescript
 * // Global database (projects registry)
 * const globalDb = getGlobalDatabase();
 * const projects = globalDb.getConnection().prepare('SELECT * FROM projects').all();
 *
 * // Project-local database (tasks, insights, etc.)
 * const projectDb = getProjectDatabaseManager().getConnection('/path/to/project');
 * const tasks = projectDb.getConnection().prepare('SELECT * FROM tasks').all();
 * ```
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { logSqliteFeatures, checkCompileOption } from './utils/sqlite-features';

/**
 * Schema version constants
 */
const GLOBAL_SCHEMA_VERSION = '002';
const PROJECT_SCHEMA_VERSION = '005';

/**
 * Base DatabaseConnection class
 * Provides common functionality for both global and project-local databases
 */
export class DatabaseConnection {
  protected db: Database.Database | null = null;
  protected dbPath: string;
  protected schemaFile: string;
  protected schemaVersion: string;
  protected logPrefix: string;

  constructor(
    dbPath: string,
    schemaFile: string,
    schemaVersion: string,
    logPrefix: string = '[Database]'
  ) {
    this.dbPath = dbPath;
    this.schemaFile = schemaFile;
    this.schemaVersion = schemaVersion;
    this.logPrefix = logPrefix;

    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
  }

  /**
   * Get or create database connection.
   */
  getConnection(): Database.Database {
    if (!this.db) {
      this.db = new Database(this.dbPath);

      // Enable foreign key constraints
      this.db.pragma('foreign_keys = ON');

      // Use WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Set synchronous mode to NORMAL
      this.db.pragma('synchronous = NORMAL');

      // Log SQLite features for debugging
      logSqliteFeatures(this.db);

      // Check FTS5 availability
      const fts5Enabled = checkCompileOption(this.db, 'ENABLE_FTS5');
      if (!fts5Enabled) {
        console.warn(
          `${this.logPrefix} WARNING: FTS5 is not enabled. Full-text search features will not work.`
        );
      }

      console.log(`${this.logPrefix} Initialized database at: ${this.dbPath}`);
    }

    return this.db;
  }

  /**
   * Execute a function within a transaction.
   */
  withTransaction<T>(fn: () => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log(`${this.logPrefix} Connection closed`);
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
   */
  getSchemaVersion(): string | null {
    const db = this.getConnection();

    try {
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
        .get() as { name: string } | undefined;

      if (!tableCheck) {
        return null;
      }

      const result = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;

      return result?.value || null;
    } catch (error) {
      console.error(`${this.logPrefix} Error getting schema version:`, error);
      return null;
    }
  }

  /**
   * Check if the database needs migration.
   */
  needsMigration(): boolean {
    const currentVersion = this.getSchemaVersion();

    if (!currentVersion) {
      console.log(`${this.logPrefix} No schema version found - migration needed`);
      return true;
    }

    const needsUpdate = currentVersion < this.schemaVersion;
    if (needsUpdate) {
      console.log(
        `${this.logPrefix} Schema version ${currentVersion} is older than ${this.schemaVersion} - migration needed`
      );
    }

    return needsUpdate;
  }

  /**
   * Initialize the database schema.
   */
  initializeSchema(schemaPath?: string): boolean {
    const db = this.getConnection();

    try {
      const resolvedSchemaPath = schemaPath || path.join(__dirname, this.schemaFile);

      if (!existsSync(resolvedSchemaPath)) {
        console.error(`${this.logPrefix} Schema file not found: ${resolvedSchemaPath}`);
        return false;
      }

      console.log(`${this.logPrefix} Initializing schema from: ${resolvedSchemaPath}`);
      const schemaSQL = readFileSync(resolvedSchemaPath, 'utf-8');

      db.exec(schemaSQL);

      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_migration', datetime('now'))").run();

      console.log(`${this.logPrefix} Schema initialized successfully (version ${this.schemaVersion})`);
      return true;
    } catch (error) {
      console.error(`${this.logPrefix} Failed to initialize schema:`, error);
      return false;
    }
  }

  /**
   * Run schema migration if needed.
   */
  migrateIfNeeded(schemaPath?: string): boolean {
    if (this.needsMigration()) {
      console.log(`${this.logPrefix} Running schema migration...`);
      return this.initializeSchema(schemaPath);
    }

    console.log(`${this.logPrefix} Schema is up to date (version ${this.getSchemaVersion()})`);
    return true;
  }
}

/**
 * Global Database Connection
 * ==========================
 *
 * Manages the global database at userData/.auto-claude/app.db
 * Contains: projects registry, app-level metadata
 */
export class GlobalDatabaseConnection extends DatabaseConnection {
  constructor() {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, '.auto-claude', 'app.db');

    super(dbPath, 'database-schema-global.sql', GLOBAL_SCHEMA_VERSION, '[GlobalDB]');
  }
}

/**
 * Project Database Connection
 * ===========================
 *
 * Manages a project-local database at <project>/.auto-claude/tasks.db
 * Contains: tasks, insights, roadmaps, analytics, etc.
 */
export class ProjectDatabaseConnection extends DatabaseConnection {
  private projectPath: string;

  constructor(projectPath: string) {
    const normalizedPath = path.normalize(projectPath);
    const dbPath = path.join(normalizedPath, '.auto-claude', 'tasks.db');

    super(dbPath, 'database-schema.sql', PROJECT_SCHEMA_VERSION, `[ProjectDB:${path.basename(normalizedPath)}]`);
    this.projectPath = normalizedPath;
  }

  /**
   * Get the project root path.
   */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Rebuild the FTS5 index from the tasks table.
   */
  rebuildFtsIndex(): boolean {
    const db = this.getConnection();

    try {
      console.log(`${this.logPrefix} Rebuilding FTS5 index...`);

      const transaction = db.transaction(() => {
        db.exec("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')");
        db.exec(`
          INSERT INTO tasks_fts(rowid, title, description, tags)
          SELECT rowid, title, description, json_extract(metadata_json, '$.tags')
          FROM tasks
        `);
      });

      transaction();

      console.log(`${this.logPrefix} FTS5 index rebuilt successfully`);
      return true;
    } catch (error) {
      console.error(`${this.logPrefix} Failed to rebuild FTS index:`, error);
      return false;
    }
  }

  /**
   * Check if all required tables exist.
   */
  checkTables(): {
    tasks: boolean;
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
      tasks: checkTable('tasks'),
      taskHistory: checkTable('task_history'),
      tasksFts: checkTable('tasks_fts'),
      undoStack: checkTable('undo_stack'),
      taskMetrics: checkTable('task_metrics'),
    };
  }
}

/**
 * Project Database Manager
 * ========================
 *
 * Manages database connections per project. Each project has its own
 * SQLite database at <project>/.auto-claude/tasks.db
 */
export class ProjectDatabaseManager {
  private connections = new Map<string, ProjectDatabaseConnection>();

  /**
   * Get the project schema path.
   * Looks in multiple locations to support both dev and prod environments.
   */
  private getSchemaPath(): string | undefined {
    const possiblePaths = [
      path.join(__dirname, 'database-schema.sql'),           // Production: alongside compiled JS
      path.join(__dirname, '../../src/main/database-schema.sql'), // Development: from out/main to src
    ];

    for (const schemaPath of possiblePaths) {
      if (existsSync(schemaPath)) {
        return schemaPath;
      }
    }

    console.warn('[ProjectDBManager] Could not find database-schema.sql');
    return undefined;
  }

  /**
   * Get a database connection for a specific project.
   * Automatically initializes the schema if needed.
   */
  getConnection(projectPath: string): ProjectDatabaseConnection {
    const normalizedPath = path.normalize(projectPath);

    if (!this.connections.has(normalizedPath)) {
      const conn = new ProjectDatabaseConnection(projectPath);
      this.connections.set(normalizedPath, conn);
      console.log(`[ProjectDBManager] Created connection for: ${normalizedPath}`);

      // Auto-initialize schema for new connections
      const schemaPath = this.getSchemaPath();
      conn.migrateIfNeeded(schemaPath);
    }

    return this.connections.get(normalizedPath)!;
  }

  /**
   * Get the database path for a project.
   */
  getDbPath(projectPath: string): string {
    return path.join(path.normalize(projectPath), '.auto-claude', 'tasks.db');
  }

  /**
   * Check if a database exists for a project.
   */
  hasDatabase(projectPath: string): boolean {
    return existsSync(this.getDbPath(projectPath));
  }

  /**
   * Initialize the database schema for a project.
   */
  initializeProject(projectPath: string, schemaPath?: string): boolean {
    const conn = this.getConnection(projectPath);
    return conn.migrateIfNeeded(schemaPath);
  }

  /**
   * Close a specific project's database connection.
   */
  closeProject(projectPath: string): void {
    const normalizedPath = path.normalize(projectPath);
    const conn = this.connections.get(normalizedPath);

    if (conn) {
      conn.close();
      this.connections.delete(normalizedPath);
      console.log(`[ProjectDBManager] Closed connection for: ${normalizedPath}`);
    }
  }

  /**
   * Close all project database connections.
   */
  closeAll(): void {
    for (const [projectPath, conn] of this.connections.entries()) {
      conn.close();
      console.log(`[ProjectDBManager] Closed connection for: ${projectPath}`);
    }
    this.connections.clear();
  }

  /**
   * Get the number of active connections.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get all active project paths.
   */
  getActiveProjects(): string[] {
    return Array.from(this.connections.keys());
  }
}

// ============================================
// Singleton Instances
// ============================================

let _globalInstance: GlobalDatabaseConnection | null = null;
let _projectManager: ProjectDatabaseManager | null = null;

/**
 * Get the global database connection (projects registry).
 * @deprecated Use getGlobalDatabase() instead
 */
export function getDatabaseConnection(): GlobalDatabaseConnection {
  return getGlobalDatabase();
}

/**
 * Get the global database connection (projects registry).
 */
export function getGlobalDatabase(): GlobalDatabaseConnection {
  if (!_globalInstance) {
    _globalInstance = new GlobalDatabaseConnection();
  }
  return _globalInstance;
}

/**
 * Close the global database connection.
 */
export function closeGlobalDatabase(): void {
  if (_globalInstance) {
    _globalInstance.close();
    _globalInstance = null;
  }
}

/**
 * @deprecated Use closeGlobalDatabase() instead
 */
export function closeDatabaseConnection(): void {
  closeGlobalDatabase();
}

/**
 * Get the project database manager.
 */
export function getProjectDatabaseManager(): ProjectDatabaseManager {
  if (!_projectManager) {
    _projectManager = new ProjectDatabaseManager();
  }
  return _projectManager;
}

/**
 * Close all project database connections.
 */
export function closeAllProjectDatabases(): void {
  if (_projectManager) {
    _projectManager.closeAll();
    _projectManager = null;
  }
}

/**
 * Close ALL database connections (global + all projects).
 * Call this on app shutdown.
 */
export function closeAllDatabases(): void {
  closeGlobalDatabase();
  closeAllProjectDatabases();
}

/**
 * Initialize the global database schema.
 * Safe to call on every app startup.
 */
export function initializeGlobalDatabase(schemaPath?: string): boolean {
  return getGlobalDatabase().migrateIfNeeded(schemaPath);
}

/**
 * @deprecated Use initializeGlobalDatabase() instead
 */
export function initializeDatabaseSchema(schemaPath?: string): boolean {
  return initializeGlobalDatabase(schemaPath);
}

/**
 * Get the expected global schema version.
 */
export function getExpectedSchemaVersion(): string {
  return GLOBAL_SCHEMA_VERSION;
}

/**
 * Get the expected project schema version.
 */
export function getExpectedProjectSchemaVersion(): string {
  return PROJECT_SCHEMA_VERSION;
}

// ============================================
// Utility Functions for Service Layer
// ============================================

/**
 * Get a project-local database connection by project path.
 * Convenience wrapper around getProjectDatabaseManager().getConnection().
 *
 * @param projectPath - Path to the project root directory
 * @returns Database connection for the project
 */
export function getProjectDatabase(projectPath: string): Database.Database {
  return getProjectDatabaseManager().getConnection(projectPath).getConnection();
}

/**
 * Get a project-local database connection by project ID.
 * Requires importing projectStore - use this for services that have projectId but not path.
 *
 * @param projectId - Project ID
 * @param projectStore - The project store instance (to avoid circular imports)
 * @returns Database connection for the project, or null if project not found
 */
export function getProjectDatabaseById(
  projectId: string,
  projectStore: { getProject: (id: string) => { path: string } | undefined }
): Database.Database | null {
  const project = projectStore.getProject(projectId);
  if (!project) {
    console.warn(`[Database] Project not found: ${projectId}`);
    return null;
  }
  return getProjectDatabase(project.path);
}

/**
 * Type for database connection that exposes the underlying better-sqlite3 Database.
 * Use this for service classes that need to store a reference.
 */
export type DatabaseInstance = Database.Database;
