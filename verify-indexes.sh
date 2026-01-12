#!/bin/bash
# Verification script for database indexes
# This script checks that SQLite is using indexes for common queries

# Get the userData directory (platform-specific)
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  USERDATA="$HOME/Library/Application Support/auto-claude"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  # Linux
  USERDATA="$HOME/.config/auto-claude"
else
  # Windows (Git Bash)
  USERDATA="$APPDATA/auto-claude"
fi

DB_PATH="$USERDATA/.auto-claude/tasks.db"

echo "=== Database Index Verification ==="
echo "Database: $DB_PATH"
echo ""

if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found. Please run the app first to create the database."
  echo "   Run: cd apps/frontend && npm run dev"
  exit 1
fi

echo "✓ Database found"
echo ""

# Test 1: Query by status (should use idx_tasks_status)
echo "Test 1: SELECT * FROM tasks WHERE status = 'in_progress'"
sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status = 'in_progress'" | grep -i "USING INDEX idx_tasks_status" > /dev/null
if [ $? -eq 0 ]; then
  echo "✓ PASS: Using index idx_tasks_status"
else
  echo "❌ FAIL: Not using index idx_tasks_status"
  sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status = 'in_progress'"
fi
echo ""

# Test 2: Query by project_id (should use idx_tasks_project_id)
echo "Test 2: SELECT * FROM tasks WHERE project_id = 'test-project'"
sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = 'test-project'" | grep -i "USING INDEX idx_tasks_project_id" > /dev/null
if [ $? -eq 0 ]; then
  echo "✓ PASS: Using index idx_tasks_project_id"
else
  echo "❌ FAIL: Not using index idx_tasks_project_id"
  sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = 'test-project'"
fi
echo ""

# Test 3: Query by location (should use idx_tasks_location)
echo "Test 3: SELECT * FROM tasks WHERE location = 'worktree'"
sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE location = 'worktree'" | grep -i "USING INDEX idx_tasks_location" > /dev/null
if [ $? -eq 0 ]; then
  echo "✓ PASS: Using index idx_tasks_location"
else
  echo "❌ FAIL: Not using index idx_tasks_location"
  sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE location = 'worktree'"
fi
echo ""

# Test 4: Query with ORDER BY updated_at (should use idx_tasks_updated_at)
echo "Test 4: SELECT * FROM tasks ORDER BY updated_at DESC"
sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks ORDER BY updated_at DESC" | grep -i "idx_tasks_updated_at" > /dev/null
if [ $? -eq 0 ]; then
  echo "✓ PASS: Using index idx_tasks_updated_at"
else
  echo "❌ FAIL: Not using index idx_tasks_updated_at"
  sqlite3 "$DB_PATH" "EXPLAIN QUERY PLAN SELECT * FROM tasks ORDER BY updated_at DESC"
fi
echo ""

# List all indexes
echo "=== All Indexes in Database ==="
sqlite3 "$DB_PATH" "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY tbl_name, name;"
echo ""

echo "=== Verification Complete ==="
