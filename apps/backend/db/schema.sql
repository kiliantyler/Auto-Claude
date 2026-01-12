-- ============================================
-- Auto Claude Backend - SQLite Schema Extensions
-- ============================================
--
-- This schema extends the frontend schema with backend-specific tables.
-- The database is shared between frontend (Electron) and backend (Python).
--
-- Database: tasks.db
-- Location: <project>/.auto-claude/tasks.db
-- ============================================

-- Enable foreign key constraints (must be set per connection)
PRAGMA foreign_keys = ON;

-- Use WAL mode for concurrent access from frontend and backend
PRAGMA journal_mode = WAL;

-- Set synchronous mode to NORMAL for good balance of safety and performance
PRAGMA synchronous = NORMAL;

-- ============================================
-- Implementation Plan Tables
-- ============================================

-- Implementation phases (extracted from implementation_plan.json)
CREATE TABLE IF NOT EXISTS implementation_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  phase_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  phase_type TEXT DEFAULT 'implementation',  -- 'setup' | 'implementation' | 'testing' | 'cleanup'
  description TEXT,
  depends_on_json TEXT,  -- JSON array of phase numbers this depends on
  status TEXT DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed'
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, phase_number)
);

-- Implementation subtasks (within phases)
CREATE TABLE IF NOT EXISTS implementation_subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase_id INTEGER NOT NULL,
  subtask_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  files_to_modify_json TEXT,  -- JSON array of file paths
  files_to_create_json TEXT,  -- JSON array of file paths
  files_to_reference_json TEXT,  -- JSON array of file paths
  actual_output TEXT,  -- Result/output from implementation
  error_message TEXT,  -- Error if failed
  attempt_count INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id) REFERENCES implementation_phases(id) ON DELETE CASCADE,
  UNIQUE(phase_id, subtask_number)
);

-- ============================================
-- Recovery Tracking Tables
-- ============================================

-- Attempt history (from attempt_history.json)
CREATE TABLE IF NOT EXISTS attempt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subtask_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  success INTEGER DEFAULT 0,  -- Boolean: 0=false, 1=true
  error TEXT,
  error_type TEXT,  -- 'build' | 'test' | 'lint' | 'type_check' | 'runtime' | 'unknown'
  recovery_action TEXT,  -- What recovery action was taken
  duration_seconds REAL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Build commits (from build_commits.json)
CREATE TABLE IF NOT EXISTS build_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  subtask_id TEXT,
  message TEXT,
  is_last_good INTEGER DEFAULT 0,  -- Boolean: last known good commit
  is_recovery_point INTEGER DEFAULT 0,  -- Boolean: recovery checkpoint
  files_changed_json TEXT,  -- JSON array of changed file paths
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ============================================
-- Task Requirements and Context Tables
-- ============================================

-- Task requirements (from requirements.json)
CREATE TABLE IF NOT EXISTS task_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  task_description TEXT NOT NULL,
  workflow_type TEXT DEFAULT 'feature',  -- 'feature' | 'bug_fix' | 'refactor' | 'test' | 'docs'
  services_involved_json TEXT,  -- JSON array of service names
  acceptance_criteria_json TEXT,  -- JSON array of criteria strings
  constraints_json TEXT,  -- JSON array of constraint strings
  dependencies_json TEXT,  -- JSON array of dependency strings
  priority TEXT DEFAULT 'medium',  -- 'low' | 'medium' | 'high' | 'critical'
  estimated_complexity TEXT,  -- 'simple' | 'standard' | 'complex'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Task context (from context.json)
CREATE TABLE IF NOT EXISTS task_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  files_to_modify_json TEXT,  -- JSON array of file paths
  files_to_create_json TEXT,  -- JSON array of file paths
  files_to_reference_json TEXT,  -- JSON array of file paths
  patterns_json TEXT,  -- JSON object of discovered patterns
  architecture_notes TEXT,  -- Architecture notes/decisions
  related_specs_json TEXT,  -- JSON array of related spec IDs
  codebase_context TEXT,  -- General codebase context
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ============================================
-- Markdown Content Columns (on tasks table)
-- ============================================

-- Note: These ALTER TABLE statements will fail silently if columns exist
-- The schema.py code handles this gracefully

-- spec_content: Full content of spec.md
-- qa_report_content: Full content of qa_report.md
-- qa_fix_request_content: Full content of QA_FIX_REQUEST.md

-- ============================================
-- Task Logs Table
-- ============================================

-- Task logs (from task_logs.json / session logs)
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  log_type TEXT NOT NULL,  -- 'info' | 'warning' | 'error' | 'debug' | 'agent' | 'tool'
  message TEXT NOT NULL,
  details_json TEXT,  -- JSON object with additional details
  agent_name TEXT,  -- Which agent generated this log
  session_id TEXT,  -- Session ID for grouping
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- ============================================
-- Test Discovery Table
-- ============================================

-- Test discovery results (from test_discovery.json)
CREATE TABLE IF NOT EXISTS test_discovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  test_file TEXT NOT NULL,
  test_name TEXT NOT NULL,
  test_type TEXT,  -- 'unit' | 'integration' | 'e2e'
  framework TEXT,  -- 'pytest' | 'jest' | 'vitest' | etc.
  status TEXT DEFAULT 'discovered',  -- 'discovered' | 'passed' | 'failed' | 'skipped'
  last_run_at TEXT,
  last_result_json TEXT,  -- JSON object with test result details
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, test_file, test_name)
);

-- ============================================
-- Indexes for Backend Tables
-- ============================================

-- Implementation phases indexes
CREATE INDEX IF NOT EXISTS idx_impl_phases_task ON implementation_phases(task_id);
CREATE INDEX IF NOT EXISTS idx_impl_phases_status ON implementation_phases(status);

-- Implementation subtasks indexes
CREATE INDEX IF NOT EXISTS idx_impl_subtasks_task ON implementation_subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_impl_subtasks_phase ON implementation_subtasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_impl_subtasks_status ON implementation_subtasks(status);

-- Attempt history indexes
CREATE INDEX IF NOT EXISTS idx_attempt_history_task ON attempt_history(task_id);
CREATE INDEX IF NOT EXISTS idx_attempt_history_subtask ON attempt_history(subtask_id);
CREATE INDEX IF NOT EXISTS idx_attempt_history_timestamp ON attempt_history(timestamp DESC);

-- Build commits indexes
CREATE INDEX IF NOT EXISTS idx_build_commits_task ON build_commits(task_id);
CREATE INDEX IF NOT EXISTS idx_build_commits_hash ON build_commits(commit_hash);
CREATE INDEX IF NOT EXISTS idx_build_commits_timestamp ON build_commits(timestamp DESC);

-- Task requirements indexes
CREATE INDEX IF NOT EXISTS idx_task_requirements_task ON task_requirements(task_id);
CREATE INDEX IF NOT EXISTS idx_task_requirements_workflow ON task_requirements(workflow_type);

-- Task contexts indexes
CREATE INDEX IF NOT EXISTS idx_task_contexts_task ON task_contexts(task_id);

-- Task logs indexes
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_subtask ON task_logs(subtask_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_type ON task_logs(log_type);
CREATE INDEX IF NOT EXISTS idx_task_logs_timestamp ON task_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_task_logs_session ON task_logs(session_id);

-- Test discovery indexes
CREATE INDEX IF NOT EXISTS idx_test_discovery_task ON test_discovery(task_id);
CREATE INDEX IF NOT EXISTS idx_test_discovery_file ON test_discovery(test_file);
CREATE INDEX IF NOT EXISTS idx_test_discovery_status ON test_discovery(status);

-- ============================================
-- Schema Version Tracking
-- ============================================

-- Update schema version for backend tables
INSERT OR REPLACE INTO metadata (key, value) VALUES ('backend_schema_version', '001');
INSERT OR REPLACE INTO metadata (key, value) VALUES ('backend_schema_updated_at', datetime('now'));
