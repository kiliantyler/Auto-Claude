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
-- - Task history table for audit logging (Phase 4A)
-- - FTS5 virtual table for full-text search (Phase 4B)
-- - Undo stack table for undo/redo operations (Phase 4C)
-- - Indexes for query optimization (<100ms latency)
-- - Triggers for automatic event emission on data changes
-- - Triggers for automatic task history recording
-- - Triggers for FTS5 index synchronization
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

-- Task History Table (Phase 4A)
-- Stores audit log of all task changes for history tracking
CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'created' | 'updated' | 'deleted' | 'status_changed' | 'moved'
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Undo Stack Table (Phase 4C)
-- Stores undo/redo operation stack per session for reversible actions
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
-- Full-Text Search (Phase 4B)
-- ============================================

-- FTS5 Virtual Table for Task Search
-- Indexes task title, description, and tags for full-text search
-- NOTE: FTS5 tables do NOT support constraints, data types, or PRIMARY KEY
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title,
  description,
  tags,
  content='tasks',
  content_rowid='rowid'
);

-- ============================================
-- Indexes for Query Optimization
-- ============================================

-- Tasks table indexes
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_location ON tasks(location);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_spec_id ON tasks(spec_id);

-- Projects table indexes
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);

-- Event queue indexes
CREATE INDEX IF NOT EXISTS idx_event_queue_timestamp ON event_queue(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_event_queue_entity ON event_queue(entity_type, entity_id);

-- Task history indexes
CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);
CREATE INDEX IF NOT EXISTS idx_task_history_timestamp ON task_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_task_history_session ON task_history(session_id);

-- Undo stack indexes
CREATE INDEX IF NOT EXISTS idx_undo_stack_session ON undo_stack(session_id, sequence);

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
-- Triggers for Task History (Phase 4A)
-- ============================================

-- Task History INSERT trigger
-- Records 'created' action when a new task is inserted
CREATE TRIGGER IF NOT EXISTS task_history_on_insert
AFTER INSERT ON tasks
BEGIN
  INSERT INTO task_history (task_id, action, new_value, changed_by, session_id)
  VALUES (
    NEW.id,
    'created',
    json_object('title', NEW.title, 'status', NEW.status, 'description', NEW.description),
    'user',
    NULL
  );
END;

-- Task History UPDATE trigger
-- Records 'updated' or 'status_changed' action when a task is updated
CREATE TRIGGER IF NOT EXISTS task_history_on_update
AFTER UPDATE ON tasks
BEGIN
  INSERT INTO task_history (task_id, action, field_name, old_value, new_value, changed_by, session_id)
  VALUES (
    NEW.id,
    CASE WHEN OLD.status != NEW.status THEN 'status_changed' ELSE 'updated' END,
    CASE
      WHEN OLD.status != NEW.status THEN 'status'
      WHEN OLD.title != NEW.title THEN 'title'
      ELSE NULL
    END,
    json_object('title', OLD.title, 'status', OLD.status, 'description', OLD.description),
    json_object('title', NEW.title, 'status', NEW.status, 'description', NEW.description),
    'user',
    NULL
  );
END;

-- Task History DELETE trigger
-- Records 'deleted' action when a task is deleted
CREATE TRIGGER IF NOT EXISTS task_history_on_delete
AFTER DELETE ON tasks
BEGIN
  INSERT INTO task_history (task_id, action, old_value, changed_by, session_id)
  VALUES (
    OLD.id,
    'deleted',
    json_object('title', OLD.title, 'status', OLD.status, 'description', OLD.description),
    'user',
    NULL
  );
END;

-- ============================================
-- Triggers for FTS5 Sync (Phase 4B)
-- ============================================

-- FTS5 INSERT trigger
-- Syncs FTS index when a new task is inserted
CREATE TRIGGER IF NOT EXISTS tasks_fts_insert
AFTER INSERT ON tasks
BEGIN
  INSERT INTO tasks_fts(rowid, title, description, tags)
  VALUES (
    NEW.rowid,
    NEW.title,
    NEW.description,
    json_extract(NEW.metadata_json, '$.tags')
  );
END;

-- FTS5 UPDATE trigger
-- Syncs FTS index when a task is updated
-- NOTE: FTS5 does NOT support UPDATE, so we delete old entry and insert new one
CREATE TRIGGER IF NOT EXISTS tasks_fts_update
AFTER UPDATE ON tasks
BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
  VALUES (
    'delete',
    OLD.rowid,
    OLD.title,
    OLD.description,
    json_extract(OLD.metadata_json, '$.tags')
  );
  INSERT INTO tasks_fts(rowid, title, description, tags)
  VALUES (
    NEW.rowid,
    NEW.title,
    NEW.description,
    json_extract(NEW.metadata_json, '$.tags')
  );
END;

-- FTS5 DELETE trigger
-- Removes task from FTS index when task is deleted
-- NOTE: Uses special 'delete' command for contentless FTS5 tables
CREATE TRIGGER IF NOT EXISTS tasks_fts_delete
AFTER DELETE ON tasks
BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description, tags)
  VALUES (
    'delete',
    OLD.rowid,
    OLD.title,
    OLD.description,
    json_extract(OLD.metadata_json, '$.tags')
  );
END;

-- ============================================
-- Initial Data
-- ============================================

-- Schema version metadata
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '003');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_migration', datetime('now'));
