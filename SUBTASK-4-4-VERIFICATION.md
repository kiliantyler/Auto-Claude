# Subtask 4-4 Verification Guide

## Objective
Verify that when `ENABLE_DUAL_WRITE=false`, the application writes ONLY to SQLite and does NOT write JSON files.

## Setup

1. **Set environment variable:**
   ```bash
   # In apps/frontend/.env
   ENABLE_DUAL_WRITE=false
   ```

2. **Start the application:**
   ```bash
   cd apps/frontend
   npm run dev
   ```

## Verification Steps

### Test 1: Create New Task (SQLite-only mode)

1. **Create a new task via UI:**
   - Click "Create New Spec"
   - Enter title and description
   - Submit the form

2. **Verify SQLite database contains the task:**
   ```bash
   # Find the database file (usually in userData/.auto-claude/tasks.db)
   sqlite3 <userData>/.auto-claude/tasks.db "SELECT id, title, status FROM tasks ORDER BY created_at DESC LIMIT 1;"
   ```
   ✅ **Expected**: Task record exists in database

3. **Verify JSON files are NOT created:**
   ```bash
   ls .auto-claude/specs/<task-id>/
   ```
   ✅ **Expected**: Directory is empty or only contains minimal structure (no implementation_plan.json, requirements.json, task_metadata.json)

4. **Check console logs:**
   ```
   [CRUD Handlers] Dual-write mode: DISABLED
   [TASK_CREATE] Skipped JSON file writes (SQLite-only mode enabled)
   [TASK_CREATE] Written to SQLite database: <task-id>
   ```

### Test 2: Update Existing Task (SQLite-only mode)

1. **Update the task:**
   - Edit the task title or description
   - Save changes

2. **Verify SQLite is updated:**
   ```bash
   sqlite3 <userData>/.auto-claude/tasks.db "SELECT title, updated_at FROM tasks WHERE id='<task-id>';"
   ```
   ✅ **Expected**: Title is updated, updated_at timestamp is recent

3. **Verify JSON files are NOT written:**
   ```bash
   ls .auto-claude/specs/<task-id>/
   ```
   ✅ **Expected**: No new JSON files created or updated

4. **Check console logs:**
   ```
   [TASK_UPDATE] Skipped JSON file writes (SQLite-only mode enabled)
   [TASK_UPDATE] Updated in SQLite database: <task-id>
   ```

### Test 3: Dual-Write Mode (for comparison)

1. **Enable dual-write mode:**
   ```bash
   # In apps/frontend/.env
   ENABLE_DUAL_WRITE=true
   ```

2. **Restart the application**

3. **Create a new task**

4. **Verify BOTH SQLite AND JSON are written:**
   ```bash
   # Check SQLite
   sqlite3 <userData>/.auto-claude/tasks.db "SELECT id, title FROM tasks WHERE id='<new-task-id>';"
   
   # Check JSON files
   ls -la .auto-claude/specs/<new-task-id>/
   # Should see: implementation_plan.json, requirements.json, task_metadata.json
   ```
   ✅ **Expected**: Both SQLite record AND JSON files exist

5. **Check console logs:**
   ```
   [CRUD Handlers] Dual-write mode: ENABLED
   [TASK_CREATE] Written JSON files to: .auto-claude/specs/<new-task-id>
   [TASK_CREATE] Written to SQLite database: <new-task-id>
   ```

### Test 4: Database Write Failure Handling

1. **Set ENABLE_DUAL_WRITE=false**

2. **Simulate database error** (optional, requires code modification):
   - Temporarily break database connection
   - Try to create a task
   - ✅ **Expected**: Error returned to user (critical failure)

3. **Set ENABLE_DUAL_WRITE=true** and repeat:
   - Try to create a task with broken database
   - ✅ **Expected**: Task creation succeeds with JSON-only (non-critical)

## Success Criteria

- ✅ ENABLE_DUAL_WRITE=false: No JSON files created/updated for tasks
- ✅ ENABLE_DUAL_WRITE=false: SQLite database is updated correctly
- ✅ ENABLE_DUAL_WRITE=true: Both JSON and SQLite are updated (Phase 1 behavior)
- ✅ Console logs show correct mode (ENABLED/DISABLED)
- ✅ Database write failures are critical in SQLite-only mode
- ✅ All UI functionality works without JSON files

## Rollback Plan

If verification fails, rollback by:

1. Set `ENABLE_DUAL_WRITE=true` in `.env`
2. Restart the application
3. Application will continue using dual-write mode (Phase 1 behavior)
4. All existing functionality preserved

## Notes

- Spec directory is still created (empty) for worktree structure
- Delete operations still remove JSON files if they exist
- Tab state continues to use JSON (UI-specific, not in database)
- Projects may still have JSON files from dual-write mode
