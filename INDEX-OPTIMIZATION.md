# Database Index Optimization

## Overview

This document describes the database indexes created for query optimization in the SQLite task storage system.

## Index Strategy

All indexes were designed to optimize common query patterns identified in the codebase, targeting <100ms query execution time as specified in the performance requirements.

## Indexes Created

### Tasks Table Indexes

| Index Name | Column(s) | Purpose | Query Pattern |
|------------|-----------|---------|---------------|
| `idx_tasks_project_id` | `project_id` | Filter tasks by project | `WHERE project_id = ?` |
| `idx_tasks_status` | `status` | Filter tasks by status (backlog, in_progress, etc.) | `WHERE status = ?` |
| `idx_tasks_location` | `location` | Filter tasks by location (main, worktree) | `WHERE location = ?` |
| `idx_tasks_created_at` | `created_at DESC` | Sort tasks by creation date | `ORDER BY created_at DESC` |
| `idx_tasks_updated_at` | `updated_at DESC` | Sort tasks by last update | `ORDER BY updated_at DESC` |
| `idx_tasks_spec_id` | `spec_id` | Lookup task by spec ID (unique) | `WHERE spec_id = ?` |

### Projects Table Indexes

| Index Name | Column(s) | Purpose |
|------------|-----------|---------|
| `idx_projects_path` | `path` | Lookup project by filesystem path (unique) |
| `idx_projects_updated_at` | `updated_at DESC` | Sort projects by last update |

### Event Queue Indexes

| Index Name | Column(s) | Purpose |
|------------|-----------|---------|
| `idx_event_queue_timestamp` | `timestamp DESC` | Retrieve recent events efficiently |
| `idx_event_queue_entity` | `entity_type, entity_id` | Lookup events by entity (composite index) |

## Common Query Patterns

### Pattern 1: List tasks for a project
```sql
SELECT * FROM tasks
WHERE project_id = ?
ORDER BY updated_at DESC
```
**Uses:** `idx_tasks_project_id` for filtering, `idx_tasks_updated_at` for sorting

### Pattern 2: Get tasks by status
```sql
SELECT * FROM tasks
WHERE status = 'in_progress'
```
**Uses:** `idx_tasks_status`

### Pattern 3: Filter tasks with multiple criteria
```sql
SELECT * FROM tasks
WHERE project_id = ? AND status = ? AND location = ?
ORDER BY updated_at DESC
```
**Uses:** SQLite query optimizer will select the most selective index from:
- `idx_tasks_project_id`
- `idx_tasks_status`
- `idx_tasks_location`

### Pattern 4: Lookup task by spec ID
```sql
SELECT * FROM tasks WHERE spec_id = ?
```
**Uses:** `idx_tasks_spec_id` (spec_id has UNIQUE constraint)

## Performance Targets

- **Query execution time:** <50ms for SELECT queries returning 100 tasks
- **Update latency:** <100ms end-to-end (database update → UI refresh)
- **Event propagation:** <50ms from database trigger to IPC event emission

## Verification

Run the verification script to confirm indexes are being used:

```bash
./verify-indexes.sh
```

This script uses `EXPLAIN QUERY PLAN` to verify that SQLite is using the appropriate indexes for common queries.

### Manual Verification

You can also manually verify index usage:

```bash
# Find the database location
DB_PATH="$HOME/Library/Application Support/auto-claude/.auto-claude/tasks.db"  # macOS
# DB_PATH="$HOME/.config/auto-claude/.auto-claude/tasks.db"  # Linux

# Check query plan for status filter
sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status = 'in_progress'"

# Expected output should include:
# SEARCH TABLE tasks USING INDEX idx_tasks_status (status=?)
```

## Future Optimizations

### Composite Indexes (if needed)

If profiling shows that multi-column queries are slow, consider adding composite indexes:

```sql
-- For project + status queries
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

-- For project + status + location queries
CREATE INDEX idx_tasks_project_status_location ON tasks(project_id, status, location);
```

**Note:** Composite indexes should only be added based on actual performance data, as they increase storage overhead and write latency.

### Partial Indexes (if needed)

For queries that frequently filter out archived tasks:

```sql
CREATE INDEX idx_tasks_active ON tasks(project_id, status)
WHERE metadata_json NOT LIKE '%"archivedAt"%';
```

## Implementation Notes

- All indexes use `IF NOT EXISTS` to allow safe schema re-execution
- Descending indexes (`DESC`) are used for timestamp columns since most queries sort newest-first
- The `spec_id` column has a UNIQUE constraint which automatically creates an index
- SQLite's query optimizer will automatically choose the most selective index for multi-column WHERE clauses

## References

- Spec: `.auto-claude/specs/017-migrate-task-storage-from-json-files-to-sqlite-dat/spec.md`
- Schema: `apps/frontend/src/main/database-schema.sql`
- Query patterns: `apps/frontend/src/main/task-storage.ts`
- Performance requirements: Spec section "Performance Optimization" (line 286-295)
