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
-- - Task metrics table for analytics and reporting (Phase 4D)
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

-- Task Metrics Table (Phase 4D)
-- Stores daily aggregated metrics for analytics and reporting
CREATE TABLE IF NOT EXISTS task_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,  -- Date in ISO format (YYYY-MM-DD)
  total_tasks INTEGER,
  completed_tasks INTEGER,
  in_progress_tasks INTEGER,
  blocked_tasks INTEGER,
  avg_completion_time_hours REAL,
  created_count INTEGER,  -- Tasks created on this date
  completed_count INTEGER,  -- Tasks completed on this date
  UNIQUE(project_id, metric_date)
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

-- Task metrics indexes
CREATE INDEX IF NOT EXISTS idx_task_metrics_date ON task_metrics(metric_date);
CREATE INDEX IF NOT EXISTS idx_task_metrics_project ON task_metrics(project_id);

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

-- ============================================
-- Project Index Table (from project_index.json)
-- ============================================

-- Stores project analysis/discovery metadata
CREATE TABLE IF NOT EXISTS project_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  project_type TEXT NOT NULL,  -- 'single' | 'distributed' | 'monorepo'
  infrastructure_json TEXT,  -- JSON serialized infrastructure config
  conventions_json TEXT,  -- JSON serialized conventions
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id)
);

-- Project services (extracted from project_index.json services object)
CREATE TABLE IF NOT EXISTS project_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_index_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  service_path TEXT NOT NULL,
  language TEXT,
  framework TEXT,
  service_type TEXT,
  package_manager TEXT,
  dependencies_json TEXT,  -- JSON array of dependencies
  FOREIGN KEY (project_index_id) REFERENCES project_index(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_index_project ON project_index(project_id);
CREATE INDEX IF NOT EXISTS idx_project_services_index ON project_services(project_index_id);
CREATE INDEX IF NOT EXISTS idx_project_services_language ON project_services(language);

-- ============================================
-- Roadmap Tables (from roadmap/*.json)
-- ============================================

-- Roadmap metadata
CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  version TEXT,
  vision TEXT,
  target_audience_json TEXT,  -- JSON: {primary, secondary[]}
  metadata_json TEXT,  -- JSON: {created_at, updated_at, generated_by, prioritization_framework}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Roadmap phases
CREATE TABLE IF NOT EXISTS roadmap_phases (
  id TEXT PRIMARY KEY,
  roadmap_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  phase_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',  -- 'planned' | 'in_progress' | 'completed'
  FOREIGN KEY (roadmap_id) REFERENCES roadmaps(id) ON DELETE CASCADE
);

-- Roadmap milestones (within phases)
CREATE TABLE IF NOT EXISTS roadmap_milestones (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  features_json TEXT,  -- JSON array of feature IDs
  FOREIGN KEY (phase_id) REFERENCES roadmap_phases(id) ON DELETE CASCADE
);

-- Roadmap features
CREATE TABLE IF NOT EXISTS roadmap_features (
  id TEXT PRIMARY KEY,
  roadmap_id TEXT NOT NULL,
  phase_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  priority TEXT,  -- 'must' | 'should' | 'could' | 'wont'
  complexity TEXT,  -- 'low' | 'medium' | 'high'
  impact TEXT,  -- 'low' | 'medium' | 'high'
  status TEXT NOT NULL DEFAULT 'planned',  -- 'planned' | 'in_progress' | 'completed' | 'under_review'
  dependencies_json TEXT,  -- JSON array of feature IDs
  acceptance_criteria_json TEXT,  -- JSON array of strings
  user_stories_json TEXT,  -- JSON array of strings
  linked_spec_id TEXT,
  competitor_insight_ids_json TEXT,  -- JSON array
  FOREIGN KEY (roadmap_id) REFERENCES roadmaps(id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id) REFERENCES roadmap_phases(id) ON DELETE SET NULL
);

-- Roadmap discovery (from roadmap_discovery.json)
CREATE TABLE IF NOT EXISTS roadmap_discovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_type TEXT,
  tech_stack_json TEXT,  -- JSON: {primary_language, frameworks[], key_dependencies[]}
  target_audience_json TEXT,  -- JSON: {primary_persona, secondary_personas[], pain_points[], goals[]}
  product_vision_json TEXT,  -- JSON: {one_liner, problem_statement, value_proposition, success_metrics[]}
  current_state_json TEXT,  -- JSON: {maturity, existing_features[], known_gaps[], technical_debt[]}
  competitive_context_json TEXT,  -- JSON: {alternatives[], differentiators[], market_position}
  constraints_json TEXT,  -- JSON: {technical[], resources[], dependencies[]}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_roadmaps_project ON roadmaps(project_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_phases_roadmap ON roadmap_phases(roadmap_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_phases_status ON roadmap_phases(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_milestones_phase ON roadmap_milestones(phase_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_roadmap ON roadmap_features(roadmap_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_phase ON roadmap_features(phase_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_priority ON roadmap_features(priority);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_status ON roadmap_features(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_discovery_project ON roadmap_discovery(project_id);

-- ============================================
-- Ideation Tables (from ideation/*.json)
-- ============================================

-- Ideation sessions
CREATE TABLE IF NOT EXISTS ideation_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  config_json TEXT,  -- JSON: {enabled_types[], include_roadmap_context, max_ideas_per_type}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Ideas (from ideation sessions)
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idea_type TEXT NOT NULL,  -- 'code_improvements' | 'ui_ux_improvements' | 'security_hardening' | 'performance_optimizations'
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  estimated_effort TEXT,  -- 'trivial' | 'small' | 'medium' | 'large'
  implementation_approach TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'proposed' | 'accepted' | 'rejected'
  builds_upon_json TEXT,  -- JSON array of idea IDs
  affected_files_json TEXT,  -- JSON array of file paths
  existing_patterns_json TEXT,  -- JSON array of patterns
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ideation_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ideation_sessions_project ON ideation_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_session ON ideas(session_id);
CREATE INDEX IF NOT EXISTS idx_ideas_type ON ideas(idea_type);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_effort ON ideas(estimated_effort);

-- ============================================
-- File Evolution Tables (from file_evolution.json)
-- ============================================

-- File evolution baselines
CREATE TABLE IF NOT EXISTS file_evolution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  baseline_commit TEXT,
  baseline_captured_at TEXT,
  baseline_content_hash TEXT,
  baseline_snapshot_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, file_path)
);

-- File evolution snapshots (per task)
CREATE TABLE IF NOT EXISTS file_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_evolution_id INTEGER NOT NULL,
  task_id TEXT,
  task_intent TEXT,
  started_at TEXT,
  completed_at TEXT,
  content_hash_before TEXT,
  content_hash_after TEXT,
  semantic_changes_json TEXT,  -- JSON array of change descriptions
  raw_diff TEXT,  -- Can be large, consider BLOB for very large diffs
  FOREIGN KEY (file_evolution_id) REFERENCES file_evolution(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_file_evolution_project ON file_evolution(project_id);
CREATE INDEX IF NOT EXISTS idx_file_evolution_path ON file_evolution(file_path);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_evolution ON file_snapshots(file_evolution_id);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_task ON file_snapshots(task_id);

-- ============================================
-- File Timelines Tables (from file-timelines/*.json)
-- ============================================

-- File timelines index
CREATE TABLE IF NOT EXISTS file_timelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  main_branch_history_json TEXT,  -- JSON array of commit history
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, file_path)
);

-- Timeline task views (per file, per task)
CREATE TABLE IF NOT EXISTS timeline_task_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timeline_id INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  branch_point_commit TEXT,
  branch_point_content_hash TEXT,
  branch_point_timestamp TEXT,
  worktree_content_hash TEXT,
  worktree_last_modified TEXT,
  task_title TEXT,
  task_description TEXT,
  from_plan INTEGER DEFAULT 0,  -- Boolean
  commits_behind_main INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'merged' | 'abandoned'
  merged_at TEXT,
  FOREIGN KEY (timeline_id) REFERENCES file_timelines(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_timelines_project ON file_timelines(project_id);
CREATE INDEX IF NOT EXISTS idx_file_timelines_path ON file_timelines(file_path);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_timeline ON timeline_task_views(timeline_id);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_task ON timeline_task_views(task_id);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_status ON timeline_task_views(status);

-- ============================================
-- Insight Sessions Tables (from insights/sessions/*.json)
-- ============================================

-- Insight sessions
CREATE TABLE IF NOT EXISTS insight_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Session messages
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant'
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  tools_used_json TEXT,  -- JSON array of {name, input, timestamp}
  FOREIGN KEY (session_id) REFERENCES insight_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_insight_sessions_project ON insight_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp DESC);

-- ============================================
-- FTS5 for Insight Sessions (searchable messages)
-- ============================================

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
  content,
  content='session_messages',
  content_rowid='rowid'
);

-- FTS5 sync triggers for session messages
CREATE TRIGGER IF NOT EXISTS session_messages_fts_insert
AFTER INSERT ON session_messages
BEGIN
  INSERT INTO session_messages_fts(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS session_messages_fts_update
AFTER UPDATE ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
  INSERT INTO session_messages_fts(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS session_messages_fts_delete
AFTER DELETE ON session_messages
BEGIN
  INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
END;

-- ============================================
-- Migration Status Table
-- ============================================

-- Tracks migration status per project for each data type
CREATE TABLE IF NOT EXISTS migration_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  data_type TEXT NOT NULL,  -- 'tasks' | 'project_index' | 'roadmap' | 'ideation' | 'file_evolution' | 'file_timelines' | 'insights'
  migrated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version TEXT NOT NULL DEFAULT '1.0',
  files_migrated_json TEXT,  -- JSON array of migrated file paths
  UNIQUE(project_path, data_type)
);

CREATE INDEX IF NOT EXISTS idx_migration_status_project ON migration_status(project_path);
CREATE INDEX IF NOT EXISTS idx_migration_status_type ON migration_status(data_type);

-- ============================================
-- Initial Data
-- ============================================

-- Schema version metadata
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '004');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_migration', datetime('now'));
