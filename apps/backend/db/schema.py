"""
Schema Initialization for Auto-Claude Backend
==============================================

Initializes the SQLite database schema for the Python backend.
Extends the frontend schema with backend-specific tables.
"""

import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .connection import DatabaseConnection


# Path to schema.sql file
SCHEMA_SQL_PATH = Path(__file__).parent / "schema.sql"

# Columns to add to tasks table for markdown content
TASKS_TABLE_COLUMNS = [
    ("spec_content", "TEXT"),
    ("qa_report_content", "TEXT"),
    ("qa_fix_request_content", "TEXT"),
]


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """Check if a column exists in a table.

    Args:
        conn: Database connection
        table: Table name
        column: Column name

    Returns:
        True if column exists, False otherwise
    """
    cursor = conn.execute(f"PRAGMA table_info({table})")
    columns = [row[1] for row in cursor.fetchall()]
    return column in columns


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    """Check if a table exists.

    Args:
        conn: Database connection
        table: Table name

    Returns:
        True if table exists, False otherwise
    """
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table,)
    )
    return cursor.fetchone() is not None


def _add_column_if_not_exists(
    conn: sqlite3.Connection,
    table: str,
    column: str,
    column_type: str
) -> bool:
    """Add a column to a table if it doesn't exist.

    Args:
        conn: Database connection
        table: Table name
        column: Column name
        column_type: SQL column type

    Returns:
        True if column was added, False if it already existed
    """
    if _column_exists(conn, table, column):
        return False

    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")
    return True


def initialize_schema(db: "DatabaseConnection") -> None:
    """Initialize the database schema.

    Creates all tables and indexes defined in schema.sql.
    Also adds markdown content columns to the tasks table.

    This function is idempotent - it can be called multiple times
    without causing errors (tables use IF NOT EXISTS).

    Args:
        db: DatabaseConnection instance
    """
    conn = db.get_connection()
    try:
        # First, check if the base tasks table exists
        # If not, we need to wait for the frontend to initialize it
        if not _table_exists(conn, "tasks"):
            # Create a minimal tasks table for standalone backend usage
            # This allows the backend to work independently if needed
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    spec_id TEXT NOT NULL UNIQUE,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'backlog',
                    review_reason TEXT,
                    released_in_version TEXT,
                    staged_in_main_project INTEGER DEFAULT 0,
                    staged_at TEXT,
                    location TEXT,
                    specs_path TEXT,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)

        # Create metadata table if it doesn't exist
        if not _table_exists(conn, "metadata"):
            conn.execute("""
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

        # Read and execute schema.sql
        if SCHEMA_SQL_PATH.exists():
            schema_sql = SCHEMA_SQL_PATH.read_text()

            # Split by semicolon and execute each statement
            # This handles multi-statement SQL files
            statements = schema_sql.split(";")
            for statement in statements:
                statement = statement.strip()
                if statement and not statement.startswith("--"):
                    try:
                        conn.execute(statement)
                    except sqlite3.OperationalError as e:
                        # Ignore errors for things like duplicate indexes
                        # or already existing objects
                        if "already exists" not in str(e):
                            raise

        # Add markdown content columns to tasks table
        for column, column_type in TASKS_TABLE_COLUMNS:
            added = _add_column_if_not_exists(conn, "tasks", column, column_type)
            if added:
                print(f"[DB] Added column {column} to tasks table")

        # Verify schema version
        cursor = conn.execute(
            "SELECT value FROM metadata WHERE key = 'backend_schema_version'"
        )
        row = cursor.fetchone()
        if row:
            print(f"[DB] Backend schema version: {row[0]}")
        else:
            # Insert initial version if not present
            conn.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
                ("backend_schema_version", "001")
            )
            print("[DB] Initialized backend schema version: 001")

    finally:
        conn.close()


def get_schema_version(db: "DatabaseConnection") -> str:
    """Get the current backend schema version.

    Args:
        db: DatabaseConnection instance

    Returns:
        Schema version string, or "unknown" if not found
    """
    row = db.fetch_one(
        "SELECT value FROM metadata WHERE key = 'backend_schema_version'"
    )
    return row[0] if row else "unknown"


def migrate_schema(db: "DatabaseConnection", target_version: str) -> None:
    """Migrate schema to a target version.

    Args:
        db: DatabaseConnection instance
        target_version: Target schema version

    Note:
        This is a placeholder for future schema migrations.
        Currently just updates the version number.
    """
    current = get_schema_version(db)
    if current == target_version:
        return

    # Future migrations would go here
    # For now, just update the version
    with db.transaction() as conn:
        conn.execute(
            "UPDATE metadata SET value = ? WHERE key = 'backend_schema_version'",
            (target_version,)
        )

    print(f"[DB] Migrated schema from {current} to {target_version}")
