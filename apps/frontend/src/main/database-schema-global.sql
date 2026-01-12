-- ============================================
-- Auto Claude - Global Database Schema
-- ============================================
--
-- This schema defines the GLOBAL database structure for app-wide data.
-- This database lives at: <userData>/.auto-claude/app.db
--
-- Contains:
-- - Projects registry (list of all projects)
-- - App-level metadata and settings
-- - Event queue for project-level notifications
--
-- Note: Tasks and all project-specific data are stored in
-- PROJECT-LOCAL databases at: <project>/.auto-claude/tasks.db
-- ============================================

-- Enable foreign key constraints (must be set per connection)
PRAGMA foreign_keys = ON;

-- Use WAL mode for better concurrency
PRAGMA journal_mode = WAL;

-- Set synchronous mode to NORMAL for good balance of safety and performance
PRAGMA synchronous = NORMAL;

-- ============================================
-- Core Tables
-- ============================================

-- Projects Table
-- Stores project metadata and settings (app-wide registry)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  auto_build_path TEXT NOT NULL,
  settings_json TEXT NOT NULL,  -- JSON serialized ProjectSettings
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Metadata Table
-- Stores application-level settings and versioning
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Event Queue Table
-- Buffers database change events for IPC consumption (project events only)
CREATE TABLE IF NOT EXISTS event_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,  -- 'insert' | 'update' | 'delete'
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- 'project'
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Undo Stack Table
-- Stores undo/redo operation stack per session for reversible actions
-- NOTE: This is global (not per-project) because:
-- 1. Users may work on multiple projects in a session
-- 2. Execute operations already look up project context from task data
-- 3. Simpler API without requiring projectPath for every undo operation
CREATE TABLE IF NOT EXISTS undo_stack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  operation TEXT NOT NULL,  -- JSON serialized operation (action type + data)
  inverse_operation TEXT NOT NULL,  -- JSON serialized inverse operation for undo
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT  -- Human-readable description of the operation
);

-- ============================================
-- Indexes for Query Optimization
-- ============================================

-- Projects table indexes
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);

-- Event queue indexes
CREATE INDEX IF NOT EXISTS idx_event_queue_timestamp ON event_queue(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_event_queue_entity ON event_queue(entity_type, entity_id);

-- Undo stack indexes
CREATE INDEX IF NOT EXISTS idx_undo_stack_session ON undo_stack(session_id, sequence);

-- ============================================
-- Triggers for Event System
-- ============================================

-- Project INSERT trigger
-- Emits 'project:created' event when a new project is inserted
CREATE TRIGGER IF NOT EXISTS project_inserted
AFTER INSERT ON projects
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('insert', NEW.id, 'project', datetime('now'));
END;

-- Project UPDATE trigger
-- Emits 'project:updated' event when a project is updated
CREATE TRIGGER IF NOT EXISTS project_updated
AFTER UPDATE ON projects
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('update', NEW.id, 'project', datetime('now'));

  -- Update the updated_at timestamp
  UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Project DELETE trigger
-- Emits 'project:deleted' event when a project is deleted
CREATE TRIGGER IF NOT EXISTS project_deleted
AFTER DELETE ON projects
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('delete', OLD.id, 'project', datetime('now'));
END;

-- ============================================
-- Initial Data
-- ============================================

-- Schema version metadata
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '002');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_type', 'global');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_migration', datetime('now'));
