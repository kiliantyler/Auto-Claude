-- ============================================
-- Auto Claude Task Storage - SQLite Schema
-- ============================================
--
-- This schema defines the database structure for task and project storage,
-- replacing the JSON file-based system with SQLite for improved performance
-- and instant real-time updates via database triggers.
--
-- Key Features:
-- - Tasks, projects, and metadata tables
-- - Event queue for IPC notification system
-- - Indexes for query optimization (<100ms latency)
-- - Triggers for automatic event emission on data changes
-- - Foreign key constraints for data integrity
--
-- Database: tasks.db
-- Location: <userData>/.auto-claude/tasks.db
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
-- Stores project metadata and settings
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  auto_build_path TEXT NOT NULL,
  settings_json TEXT NOT NULL,  -- JSON serialized ProjectSettings
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks Table
-- Stores task records with all metadata
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog',  -- 'backlog' | 'in_progress' | 'ai_review' | 'human_review' | 'done'
  review_reason TEXT,  -- 'completed' | 'errors' | 'qa_rejected' | 'plan_review' (only when status='human_review')
  released_in_version TEXT,
  staged_in_main_project INTEGER DEFAULT 0,  -- Boolean: 0=false, 1=true
  staged_at TEXT,  -- ISO timestamp
  location TEXT,  -- 'main' | 'worktree'
  specs_path TEXT,
  metadata_json TEXT,  -- JSON serialized TaskMetadata (includes subtasks, QA reports, logs, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Metadata Table
-- Stores application-level settings and versioning
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Event Queue Table
-- Buffers database change events for IPC consumption
CREATE TABLE IF NOT EXISTS event_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,  -- 'insert' | 'update' | 'delete'
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- 'task' | 'project'
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- Indexes for Query Optimization
-- ============================================

-- Tasks table indexes
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_spec_id ON tasks(spec_id);

-- Projects table indexes
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);

-- Event queue indexes
CREATE INDEX IF NOT EXISTS idx_event_queue_timestamp ON event_queue(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_event_queue_entity ON event_queue(entity_type, entity_id);

-- ============================================
-- Triggers for Event System
-- ============================================

-- Task INSERT trigger
-- Emits 'task:created' event when a new task is inserted
CREATE TRIGGER IF NOT EXISTS task_inserted
AFTER INSERT ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('insert', NEW.id, 'task', datetime('now'));
END;

-- Task UPDATE trigger
-- Emits 'task:updated' event when a task is updated
CREATE TRIGGER IF NOT EXISTS task_updated
AFTER UPDATE ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('update', NEW.id, 'task', datetime('now'));

  -- Update the updated_at timestamp
  UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Task DELETE trigger
-- Emits 'task:deleted' event when a task is deleted
CREATE TRIGGER IF NOT EXISTS task_deleted
AFTER DELETE ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('delete', OLD.id, 'task', datetime('now'));
END;

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
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '001');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_migration', datetime('now'));
