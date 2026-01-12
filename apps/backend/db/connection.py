"""
SQLite Connection Management for Python Backend
================================================

Provides connection management compatible with frontend schema.
Database location: <project>/.auto-claude/tasks.db

The database is shared with the Electron frontend, so both can read/write
task state. Uses WAL mode for concurrent access.
"""

import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Generator, Optional

# Thread-local storage for connections
_local = threading.local()

# Global database path (set by init_db_for_project)
_db_path: Optional[Path] = None


class DatabaseConnection:
    """SQLite database connection manager.

    Manages connections to the project-local SQLite database.
    Uses WAL mode for concurrent access from frontend and backend.
    """

    def __init__(self, db_path: Path):
        """Initialize with database path.

        Args:
            db_path: Path to the SQLite database file
        """
        self.db_path = db_path
        self._ensure_db_dir()

    def _ensure_db_dir(self) -> None:
        """Ensure the database directory exists."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def get_connection(self) -> sqlite3.Connection:
        """Get a database connection.

        Returns a new connection configured with:
        - WAL journal mode for concurrent access
        - Foreign key constraints enabled
        - Row factory for dict-like row access
        - 30 second timeout for lock acquisition

        Returns:
            sqlite3.Connection: Configured database connection
        """
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=30.0,
            check_same_thread=False,
            isolation_level=None  # Auto-commit mode, we handle transactions
        )
        conn.row_factory = sqlite3.Row

        # Configure pragmas for compatibility with frontend
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")

        return conn

    @contextmanager
    def transaction(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database transactions.

        Provides automatic commit on success and rollback on failure.

        Yields:
            sqlite3.Connection: Database connection within transaction

        Example:
            with db.transaction() as conn:
                conn.execute("INSERT INTO tasks ...")
                conn.execute("INSERT INTO phases ...")
            # Auto-commits if no exception
        """
        conn = self.get_connection()
        try:
            conn.execute("BEGIN TRANSACTION")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        """Execute a single SQL statement.

        Args:
            sql: SQL statement to execute
            params: Parameters for the SQL statement

        Returns:
            sqlite3.Cursor: Cursor with results
        """
        conn = self.get_connection()
        try:
            return conn.execute(sql, params)
        finally:
            conn.close()

    def execute_many(self, sql: str, params_list: list[tuple]) -> None:
        """Execute a SQL statement with multiple parameter sets.

        Args:
            sql: SQL statement to execute
            params_list: List of parameter tuples
        """
        conn = self.get_connection()
        try:
            conn.executemany(sql, params_list)
        finally:
            conn.close()

    def fetch_one(self, sql: str, params: tuple = ()) -> Optional[sqlite3.Row]:
        """Fetch a single row.

        Args:
            sql: SQL query to execute
            params: Parameters for the query

        Returns:
            sqlite3.Row or None: Single row result
        """
        conn = self.get_connection()
        try:
            cursor = conn.execute(sql, params)
            return cursor.fetchone()
        finally:
            conn.close()

    def fetch_all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        """Fetch all rows.

        Args:
            sql: SQL query to execute
            params: Parameters for the query

        Returns:
            list[sqlite3.Row]: All matching rows
        """
        conn = self.get_connection()
        try:
            cursor = conn.execute(sql, params)
            return cursor.fetchall()
        finally:
            conn.close()


def get_db_connection() -> Optional[DatabaseConnection]:
    """Get the current database connection instance.

    Returns:
        DatabaseConnection or None: Current connection if initialized
    """
    global _db_path
    if _db_path is None:
        return None
    return DatabaseConnection(_db_path)


def init_db_for_project(project_dir: Path) -> DatabaseConnection:
    """Initialize database for a project.

    Creates the database file if it doesn't exist and initializes
    the schema. Sets the global database path for get_db_connection().

    Args:
        project_dir: Path to the project root directory

    Returns:
        DatabaseConnection: Initialized database connection
    """
    global _db_path

    db_path = project_dir / ".auto-claude" / "tasks.db"
    _db_path = db_path

    db = DatabaseConnection(db_path)

    # Initialize schema if needed
    from .schema import initialize_schema
    initialize_schema(db)

    return db


def get_db_path_for_project(project_dir: Path) -> Path:
    """Get the database path for a project.

    Args:
        project_dir: Path to the project root directory

    Returns:
        Path: Full path to the database file
    """
    return project_dir / ".auto-claude" / "tasks.db"
