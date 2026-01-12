"""
Base Repository for Auto-Claude Backend
========================================

Provides common CRUD operations for all database repositories.
Uses the repository pattern for clean data access abstraction.
"""

import json
import sqlite3
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Generic, Optional, TypeVar

from .connection import DatabaseConnection

# Generic type for repository entities
T = TypeVar("T")


class BaseRepository(ABC, Generic[T]):
    """Abstract base class for database repositories.

    Provides common CRUD operations and utility methods.
    Subclasses must implement entity-specific operations.

    Attributes:
        db: DatabaseConnection instance
        table_name: Name of the database table
        spec_id: Spec ID for filtering (optional)
    """

    def __init__(
        self,
        db: DatabaseConnection,
        table_name: str,
        spec_id: Optional[str] = None
    ):
        """Initialize the repository.

        Args:
            db: DatabaseConnection instance
            table_name: Name of the database table
            spec_id: Optional spec ID for filtering operations
        """
        self.db = db
        self.table_name = table_name
        self.spec_id = spec_id

    @abstractmethod
    def to_entity(self, row: sqlite3.Row) -> T:
        """Convert a database row to an entity object.

        Args:
            row: SQLite row object

        Returns:
            Entity object of type T
        """
        pass

    @abstractmethod
    def to_row(self, entity: T) -> dict[str, Any]:
        """Convert an entity object to a dictionary for database insertion.

        Args:
            entity: Entity object

        Returns:
            Dictionary of column names to values
        """
        pass

    def _get_task_id(self) -> Optional[str]:
        """Get the task ID for the current spec_id.

        Returns:
            Task ID string or None if spec_id not set
        """
        if not self.spec_id:
            return None

        row = self.db.fetch_one(
            "SELECT id FROM tasks WHERE spec_id = ?",
            (self.spec_id,)
        )
        return row["id"] if row else None

    def _json_serialize(self, value: Any) -> Optional[str]:
        """Serialize a value to JSON string.

        Args:
            value: Value to serialize

        Returns:
            JSON string or None if value is None
        """
        if value is None:
            return None
        return json.dumps(value)

    def _json_deserialize(self, value: Optional[str]) -> Any:
        """Deserialize a JSON string to Python object.

        Args:
            value: JSON string to deserialize

        Returns:
            Python object or None if value is None/empty
        """
        if not value:
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None

    def _now(self) -> str:
        """Get current timestamp in ISO format.

        Returns:
            ISO format timestamp string
        """
        return datetime.now().isoformat()

    def find_by_id(self, id_value: Any) -> Optional[T]:
        """Find an entity by its primary key.

        Args:
            id_value: Primary key value

        Returns:
            Entity object or None if not found
        """
        row = self.db.fetch_one(
            f"SELECT * FROM {self.table_name} WHERE id = ?",
            (id_value,)
        )
        return self.to_entity(row) if row else None

    def find_all(self, limit: Optional[int] = None) -> list[T]:
        """Find all entities in the table.

        Args:
            limit: Optional maximum number of results

        Returns:
            List of entity objects
        """
        sql = f"SELECT * FROM {self.table_name}"
        if limit:
            sql += f" LIMIT {limit}"

        rows = self.db.fetch_all(sql)
        return [self.to_entity(row) for row in rows]

    def find_by_task_id(self, task_id: str) -> list[T]:
        """Find all entities for a specific task.

        Args:
            task_id: Task ID to filter by

        Returns:
            List of entity objects
        """
        rows = self.db.fetch_all(
            f"SELECT * FROM {self.table_name} WHERE task_id = ?",
            (task_id,)
        )
        return [self.to_entity(row) for row in rows]

    def insert(self, entity: T) -> int:
        """Insert a new entity into the database.

        Args:
            entity: Entity object to insert

        Returns:
            Row ID of inserted record
        """
        data = self.to_row(entity)
        columns = ", ".join(data.keys())
        placeholders = ", ".join(["?" for _ in data])
        values = tuple(data.values())

        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"INSERT INTO {self.table_name} ({columns}) VALUES ({placeholders})",
                values
            )
            return cursor.lastrowid

    def update(self, id_value: Any, updates: dict[str, Any]) -> bool:
        """Update an existing entity.

        Args:
            id_value: Primary key value
            updates: Dictionary of column names to new values

        Returns:
            True if entity was updated, False if not found
        """
        if not updates:
            return False

        # Add updated_at timestamp if column exists
        if "updated_at" not in updates:
            updates["updated_at"] = self._now()

        set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
        values = tuple(updates.values()) + (id_value,)

        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE {self.table_name} SET {set_clause} WHERE id = ?",
                values
            )
            return cursor.rowcount > 0

    def delete(self, id_value: Any) -> bool:
        """Delete an entity by its primary key.

        Args:
            id_value: Primary key value

        Returns:
            True if entity was deleted, False if not found
        """
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"DELETE FROM {self.table_name} WHERE id = ?",
                (id_value,)
            )
            return cursor.rowcount > 0

    def delete_by_task_id(self, task_id: str) -> int:
        """Delete all entities for a specific task.

        Args:
            task_id: Task ID to delete entities for

        Returns:
            Number of deleted records
        """
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"DELETE FROM {self.table_name} WHERE task_id = ?",
                (task_id,)
            )
            return cursor.rowcount

    def upsert(self, entity: T, conflict_columns: list[str]) -> int:
        """Insert or update an entity (upsert).

        Args:
            entity: Entity object to upsert
            conflict_columns: Columns that define uniqueness

        Returns:
            Row ID of inserted/updated record
        """
        data = self.to_row(entity)
        columns = ", ".join(data.keys())
        placeholders = ", ".join(["?" for _ in data])
        values = tuple(data.values())

        # Build ON CONFLICT clause
        conflict = ", ".join(conflict_columns)
        update_clause = ", ".join([
            f"{k} = excluded.{k}"
            for k in data.keys()
            if k not in conflict_columns
        ])

        sql = f"""
            INSERT INTO {self.table_name} ({columns})
            VALUES ({placeholders})
            ON CONFLICT ({conflict}) DO UPDATE SET {update_clause}
        """

        with self.db.transaction() as conn:
            cursor = conn.execute(sql, values)
            return cursor.lastrowid

    def count(self, where: Optional[str] = None, params: tuple = ()) -> int:
        """Count entities in the table.

        Args:
            where: Optional WHERE clause (without 'WHERE' keyword)
            params: Parameters for the WHERE clause

        Returns:
            Count of matching entities
        """
        sql = f"SELECT COUNT(*) FROM {self.table_name}"
        if where:
            sql += f" WHERE {where}"

        row = self.db.fetch_one(sql, params)
        return row[0] if row else 0

    def exists(self, id_value: Any) -> bool:
        """Check if an entity exists by its primary key.

        Args:
            id_value: Primary key value

        Returns:
            True if entity exists, False otherwise
        """
        row = self.db.fetch_one(
            f"SELECT 1 FROM {self.table_name} WHERE id = ? LIMIT 1",
            (id_value,)
        )
        return row is not None
