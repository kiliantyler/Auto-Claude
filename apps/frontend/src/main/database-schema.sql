-- ============================================
-- Auto Claude - Project-Local Database Schema
-- ============================================
--
-- This schema defines the PROJECT-LOCAL database structure.
-- Each project has its own database at: <project>/.auto-claude/tasks.db
--
-- This database is SHARED between:
-- - Electron frontend (via better-sqlite3)
-- - Python backend (via sqlite3)
--
-- Contains all project-specific data:
-- - Tasks and task history
-- - Implementation plans, subtasks
-- - Roadmaps, ideation, insights
-- - File evolution and timelines
-- - Analytics and metrics
--
-- Note: The global projects registry is stored separately at:
-- <userData>/.auto-claude/app.db
-- ============================================

-- Enable foreign key constraints (must be set per connection)
PRAGMA foreign_keys = ON;

-- Use WAL mode for better concurrency (frontend + backend access)
PRAGMA journal_mode = WAL;

-- Set synchronous mode to NORMAL for good balance of safety and performance
PRAGMA synchronous = NORMAL;

-- ============================================
-- Core Tables
-- ============================================

-- Tasks Table
-- Stores task records with all metadata
-- Note: project_id is stored for reference but not as a foreign key
-- (projects table is in the global database)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,  -- Reference to project in global DB (not a foreign key)
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Metadata Table
-- Stores project-level settings and versioning
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
  entity_type TEXT NOT NULL,  -- 'task' | 'roadmap' | 'insight' | etc.
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task History Table
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

-- Undo Stack Table
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

-- Task Metrics Table
-- Stores daily aggregated metrics for analytics and reporting
CREATE TABLE IF NOT EXISTS task_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
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
-- Full-Text Search
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
-- Project Index Tables
-- ============================================

-- Stores project analysis/discovery metadata
CREATE TABLE IF NOT EXISTS project_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL UNIQUE,  -- Reference to project (not a foreign key)
  project_root TEXT NOT NULL,
  project_type TEXT NOT NULL,  -- 'single' | 'distributed' | 'monorepo'
  infrastructure_json TEXT,  -- JSON serialized infrastructure config
  conventions_json TEXT,  -- JSON serialized conventions
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ============================================
-- Roadmap Tables
-- ============================================

-- Roadmap metadata
CREATE TABLE IF NOT EXISTS roadmaps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  project_name TEXT NOT NULL,
  version TEXT,
  vision TEXT,
  target_audience_json TEXT,  -- JSON: {primary, secondary[]}
  metadata_json TEXT,  -- JSON: {created_at, updated_at, generated_by, prioritization_framework}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Roadmap discovery
CREATE TABLE IF NOT EXISTS roadmap_discovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  project_name TEXT NOT NULL,
  project_type TEXT,
  tech_stack_json TEXT,  -- JSON: {primary_language, frameworks[], key_dependencies[]}
  target_audience_json TEXT,  -- JSON: {primary_persona, secondary_personas[], pain_points[], goals[]}
  product_vision_json TEXT,  -- JSON: {one_liner, problem_statement, value_proposition, success_metrics[]}
  current_state_json TEXT,  -- JSON: {maturity, existing_features[], known_gaps[], technical_debt[]}
  competitive_context_json TEXT,  -- JSON: {alternatives[], differentiators[], market_position}
  constraints_json TEXT,  -- JSON: {technical[], resources[], dependencies[]}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- Ideation Tables
-- ============================================

-- Ideation sessions
CREATE TABLE IF NOT EXISTS ideation_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  config_json TEXT,  -- JSON: {enabled_types[], include_roadmap_context, max_ideas_per_type}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ============================================
-- File Evolution Tables
-- ============================================

-- File evolution baselines
CREATE TABLE IF NOT EXISTS file_evolution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  file_path TEXT NOT NULL,
  baseline_commit TEXT,
  baseline_captured_at TEXT,
  baseline_content_hash TEXT,
  baseline_snapshot_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- ============================================
-- File Timelines Tables
-- ============================================

-- File timelines index
CREATE TABLE IF NOT EXISTS file_timelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  file_path TEXT NOT NULL,
  main_branch_history_json TEXT,  -- JSON array of commit history
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- ============================================
-- Insight Sessions Tables
-- ============================================

-- Insight sessions (AI-powered codebase insights chat)
-- Replaces .auto-claude/insights/sessions/*.json files
CREATE TABLE IF NOT EXISTS insight_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key)
  title TEXT,
  model_config_json TEXT,  -- JSON: {model, thinkingLevel} - per-session model configuration
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Session messages (chat messages within insight sessions)
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant'
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  tools_used_json TEXT,  -- JSON array of {name, input, timestamp}
  suggested_task_json TEXT,  -- JSON: {title, description, rationale} - for assistant messages
  FOREIGN KEY (session_id) REFERENCES insight_sessions(id) ON DELETE CASCADE
);

-- Current insight session pointer (tracks which session is active per project)
-- Replaces .auto-claude/insights/current_session.json files
CREATE TABLE IF NOT EXISTS current_insight_session (
  project_id TEXT PRIMARY KEY,  -- Reference to project (not a foreign key)
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES insight_sessions(id) ON DELETE CASCADE
);

-- ============================================
-- Migration Status Table
-- ============================================

-- Tracks migration status for each data type
CREATE TABLE IF NOT EXISTS migration_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_type TEXT NOT NULL UNIQUE,  -- 'tasks' | 'project_index' | 'roadmap' | 'ideation' | 'file_evolution' | 'file_timelines' | 'insights'
  migrated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version TEXT NOT NULL DEFAULT '1.0',
  files_migrated_json TEXT  -- JSON array of migrated file paths
);

-- ============================================
-- Task Logs Table
-- ============================================

-- Task logs (phase-based logs from Python backend)
-- Replaces task_logs.json files with SQLite storage
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  log_type TEXT NOT NULL,  -- 'info' | 'warning' | 'error' | 'debug' | 'agent' | 'tool' | 'phase_status' | 'phase_start'
  message TEXT NOT NULL,
  details_json TEXT,  -- JSON object with additional details (phase, tool_name, tool_input, session, etc.)
  agent_name TEXT,  -- Which agent generated this log
  session_id TEXT,  -- Session ID for grouping
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ============================================
-- Terminal Worktrees Table
-- ============================================

-- Terminal worktree configurations
-- Replaces .auto-claude/terminal/metadata/*.json files
CREATE TABLE IF NOT EXISTS terminal_worktrees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,  -- Reference to project (not a foreign key - projects in global DB)
  name TEXT NOT NULL,  -- Unique worktree name (used as directory name)
  worktree_path TEXT NOT NULL,  -- Path to the worktree directory
  branch_name TEXT,  -- Git branch name (terminal/{name}) - empty/null if no branch created
  base_branch TEXT NOT NULL,  -- Base branch the worktree was created from
  has_git_branch INTEGER NOT NULL DEFAULT 0,  -- Boolean: whether a git branch was created
  task_id TEXT,  -- Associated task ID (optional)
  terminal_id TEXT,  -- Terminal ID this worktree is associated with
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)  -- Name must be unique within a project
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

-- Project index indexes
CREATE INDEX IF NOT EXISTS idx_project_index_project ON project_index(project_id);
CREATE INDEX IF NOT EXISTS idx_project_services_index ON project_services(project_index_id);
CREATE INDEX IF NOT EXISTS idx_project_services_language ON project_services(language);

-- Roadmap indexes
CREATE INDEX IF NOT EXISTS idx_roadmaps_project ON roadmaps(project_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_phases_roadmap ON roadmap_phases(roadmap_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_phases_status ON roadmap_phases(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_milestones_phase ON roadmap_milestones(phase_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_roadmap ON roadmap_features(roadmap_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_phase ON roadmap_features(phase_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_priority ON roadmap_features(priority);
CREATE INDEX IF NOT EXISTS idx_roadmap_features_status ON roadmap_features(status);
CREATE INDEX IF NOT EXISTS idx_roadmap_discovery_project ON roadmap_discovery(project_id);

-- Ideation indexes
CREATE INDEX IF NOT EXISTS idx_ideation_sessions_project ON ideation_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_session ON ideas(session_id);
CREATE INDEX IF NOT EXISTS idx_ideas_type ON ideas(idea_type);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_effort ON ideas(estimated_effort);

-- File evolution indexes
CREATE INDEX IF NOT EXISTS idx_file_evolution_project ON file_evolution(project_id);
CREATE INDEX IF NOT EXISTS idx_file_evolution_path ON file_evolution(file_path);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_evolution ON file_snapshots(file_evolution_id);
CREATE INDEX IF NOT EXISTS idx_file_snapshots_task ON file_snapshots(task_id);

-- File timelines indexes
CREATE INDEX IF NOT EXISTS idx_file_timelines_project ON file_timelines(project_id);
CREATE INDEX IF NOT EXISTS idx_file_timelines_path ON file_timelines(file_path);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_timeline ON timeline_task_views(timeline_id);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_task ON timeline_task_views(task_id);
CREATE INDEX IF NOT EXISTS idx_timeline_task_views_status ON timeline_task_views(status);

-- Insight sessions indexes
CREATE INDEX IF NOT EXISTS idx_insight_sessions_project ON insight_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_insight_sessions_updated ON insight_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_current_insight_session_session ON current_insight_session(session_id);

-- Migration status indexes
CREATE INDEX IF NOT EXISTS idx_migration_status_type ON migration_status(data_type);

-- Task logs indexes
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_subtask ON task_logs(subtask_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_type ON task_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_task_logs_timestamp ON task_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_session ON task_logs(session_id);

-- Terminal worktrees indexes
CREATE INDEX IF NOT EXISTS idx_terminal_worktrees_project ON terminal_worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_terminal_worktrees_name ON terminal_worktrees(name);
CREATE INDEX IF NOT EXISTS idx_terminal_worktrees_task ON terminal_worktrees(task_id);

-- ============================================
-- Triggers for Event System
-- ============================================

-- Task INSERT trigger
CREATE TRIGGER IF NOT EXISTS task_inserted
AFTER INSERT ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('insert', NEW.id, 'task', datetime('now'));
END;

-- Task UPDATE trigger
CREATE TRIGGER IF NOT EXISTS task_updated
AFTER UPDATE ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('update', NEW.id, 'task', datetime('now'));

  -- Update the updated_at timestamp
  UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Task DELETE trigger
CREATE TRIGGER IF NOT EXISTS task_deleted
AFTER DELETE ON tasks
BEGIN
  INSERT INTO event_queue (event_type, entity_id, entity_type, timestamp)
  VALUES ('delete', OLD.id, 'task', datetime('now'));
END;

-- ============================================
-- Triggers for Task History
-- ============================================

-- Task History INSERT trigger
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
-- Triggers for FTS5 Sync
-- ============================================

-- FTS5 INSERT trigger
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
-- FTS5 for Insight Sessions
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
-- Initial Data
-- ============================================

-- Schema version metadata
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '008');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_type', 'project-local');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_migration', datetime('now'));
