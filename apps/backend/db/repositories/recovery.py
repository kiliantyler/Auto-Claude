"""
Recovery Repository
===================

Provides database operations for recovery tracking - attempt history
and build commits. Replaces JSON file-based storage with SQLite.
"""

import json
from datetime import datetime
from typing import Any, Optional

from ..connection import DatabaseConnection


class RecoveryRepository:
    """Repository for recovery tracking database operations.

    Manages attempt history and build commits for task recovery.
    This replaces the attempt_history.json and build_commits.json files.
    """

    def __init__(self, db: DatabaseConnection, spec_id: str):
        """Initialize the repository.

        Args:
            db: DatabaseConnection instance
            spec_id: Spec ID (e.g., "001-feature-name")
        """
        self.db = db
        self.spec_id = spec_id
        self._task_id: Optional[str] = None

    @property
    def task_id(self) -> Optional[str]:
        """Get the task ID for this spec."""
        if self._task_id is None:
            row = self.db.fetch_one(
                "SELECT id FROM tasks WHERE spec_id = ?",
                (self.spec_id,)
            )
            if row:
                self._task_id = row["id"]
        return self._task_id

    def _now(self) -> str:
        """Get current timestamp in ISO format."""
        return datetime.now().isoformat()

    def _json_serialize(self, value: Any) -> Optional[str]:
        """Serialize a value to JSON string."""
        if value is None:
            return None
        return json.dumps(value)

    def _json_deserialize(self, value: Optional[str]) -> Any:
        """Deserialize a JSON string to Python object."""
        if not value:
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return None

    # ==========================================
    # Attempt History Operations
    # ==========================================

    def record_attempt(
        self,
        subtask_id: str,
        attempt_number: int,
        success: bool,
        error: Optional[str] = None,
        error_type: Optional[str] = None,
        recovery_action: Optional[str] = None,
        duration_seconds: Optional[float] = None
    ) -> int:
        """Record a subtask attempt.

        Args:
            subtask_id: ID of the subtask
            attempt_number: Which attempt this is (1, 2, 3, ...)
            success: Whether the attempt succeeded
            error: Error message if failed
            error_type: Type of error (build, test, lint, etc.)
            recovery_action: What recovery action was taken
            duration_seconds: How long the attempt took

        Returns:
            ID of the created record
        """
        task_id = self.task_id
        if not task_id:
            raise ValueError(f"Task not found for spec_id: {self.spec_id}")

        with self.db.transaction() as conn:
            cursor = conn.execute(
                """INSERT INTO attempt_history
                   (task_id, subtask_id, attempt_number, success, error,
                    error_type, recovery_action, duration_seconds)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    subtask_id,
                    attempt_number,
                    1 if success else 0,
                    error,
                    error_type,
                    recovery_action,
                    duration_seconds,
                )
            )
            return cursor.lastrowid

    def get_attempt_history(self, subtask_id: Optional[str] = None) -> list[dict]:
        """Get attempt history for a subtask or all subtasks.

        Args:
            subtask_id: Optional subtask ID to filter by

        Returns:
            List of attempt records
        """
        task_id = self.task_id
        if not task_id:
            return []

        if subtask_id:
            rows = self.db.fetch_all(
                """SELECT * FROM attempt_history
                   WHERE task_id = ? AND subtask_id = ?
                   ORDER BY attempt_number""",
                (task_id, subtask_id)
            )
        else:
            rows = self.db.fetch_all(
                """SELECT * FROM attempt_history
                   WHERE task_id = ?
                   ORDER BY subtask_id, attempt_number""",
                (task_id,)
            )

        return [
            {
                "id": row["id"],
                "subtask_id": row["subtask_id"],
                "attempt_number": row["attempt_number"],
                "success": bool(row["success"]),
                "error": row["error"],
                "error_type": row["error_type"],
                "recovery_action": row["recovery_action"],
                "duration_seconds": row["duration_seconds"],
                "timestamp": row["timestamp"],
            }
            for row in rows
        ]

    def get_attempt_count(self, subtask_id: str) -> int:
        """Get the number of attempts for a subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            Number of attempts
        """
        task_id = self.task_id
        if not task_id:
            return 0

        row = self.db.fetch_one(
            """SELECT COUNT(*) as count FROM attempt_history
               WHERE task_id = ? AND subtask_id = ?""",
            (task_id, subtask_id)
        )
        return row["count"] if row else 0

    def get_last_attempt(self, subtask_id: str) -> Optional[dict]:
        """Get the most recent attempt for a subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            Attempt record or None
        """
        task_id = self.task_id
        if not task_id:
            return None

        row = self.db.fetch_one(
            """SELECT * FROM attempt_history
               WHERE task_id = ? AND subtask_id = ?
               ORDER BY attempt_number DESC
               LIMIT 1""",
            (task_id, subtask_id)
        )

        if not row:
            return None

        return {
            "id": row["id"],
            "subtask_id": row["subtask_id"],
            "attempt_number": row["attempt_number"],
            "success": bool(row["success"]),
            "error": row["error"],
            "error_type": row["error_type"],
            "recovery_action": row["recovery_action"],
            "duration_seconds": row["duration_seconds"],
            "timestamp": row["timestamp"],
        }

    # ==========================================
    # Build Commits Operations
    # ==========================================

    def record_commit(
        self,
        commit_hash: str,
        subtask_id: Optional[str] = None,
        message: Optional[str] = None,
        is_last_good: bool = False,
        is_recovery_point: bool = False,
        files_changed: Optional[list[str]] = None
    ) -> int:
        """Record a build commit.

        Args:
            commit_hash: Git commit hash
            subtask_id: Optional subtask ID this commit relates to
            message: Commit message
            is_last_good: Whether this is the last known good commit
            is_recovery_point: Whether this is a recovery checkpoint
            files_changed: List of files changed in the commit

        Returns:
            ID of the created record
        """
        task_id = self.task_id
        if not task_id:
            raise ValueError(f"Task not found for spec_id: {self.spec_id}")

        # If marking as last_good, clear previous last_good flag
        if is_last_good:
            with self.db.transaction() as conn:
                conn.execute(
                    "UPDATE build_commits SET is_last_good = 0 WHERE task_id = ?",
                    (task_id,)
                )

        with self.db.transaction() as conn:
            cursor = conn.execute(
                """INSERT INTO build_commits
                   (task_id, commit_hash, subtask_id, message,
                    is_last_good, is_recovery_point, files_changed_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    commit_hash,
                    subtask_id,
                    message,
                    1 if is_last_good else 0,
                    1 if is_recovery_point else 0,
                    self._json_serialize(files_changed),
                )
            )
            return cursor.lastrowid

    def get_commits(self, limit: Optional[int] = None) -> list[dict]:
        """Get build commits for this task.

        Args:
            limit: Optional maximum number of commits to return

        Returns:
            List of commit records (newest first)
        """
        task_id = self.task_id
        if not task_id:
            return []

        sql = """SELECT * FROM build_commits
                 WHERE task_id = ?
                 ORDER BY timestamp DESC"""
        if limit:
            sql += f" LIMIT {limit}"

        rows = self.db.fetch_all(sql, (task_id,))

        return [
            {
                "id": row["id"],
                "commit_hash": row["commit_hash"],
                "subtask_id": row["subtask_id"],
                "message": row["message"],
                "is_last_good": bool(row["is_last_good"]),
                "is_recovery_point": bool(row["is_recovery_point"]),
                "files_changed": self._json_deserialize(row["files_changed_json"]),
                "timestamp": row["timestamp"],
            }
            for row in rows
        ]

    def get_last_good_commit(self) -> Optional[dict]:
        """Get the last known good commit.

        Returns:
            Commit record or None
        """
        task_id = self.task_id
        if not task_id:
            return None

        row = self.db.fetch_one(
            """SELECT * FROM build_commits
               WHERE task_id = ? AND is_last_good = 1
               ORDER BY timestamp DESC
               LIMIT 1""",
            (task_id,)
        )

        if not row:
            return None

        return {
            "id": row["id"],
            "commit_hash": row["commit_hash"],
            "subtask_id": row["subtask_id"],
            "message": row["message"],
            "is_last_good": True,
            "is_recovery_point": bool(row["is_recovery_point"]),
            "files_changed": self._json_deserialize(row["files_changed_json"]),
            "timestamp": row["timestamp"],
        }

    def get_recovery_points(self) -> list[dict]:
        """Get all recovery point commits.

        Returns:
            List of recovery point commit records
        """
        task_id = self.task_id
        if not task_id:
            return []

        rows = self.db.fetch_all(
            """SELECT * FROM build_commits
               WHERE task_id = ? AND is_recovery_point = 1
               ORDER BY timestamp DESC""",
            (task_id,)
        )

        return [
            {
                "id": row["id"],
                "commit_hash": row["commit_hash"],
                "subtask_id": row["subtask_id"],
                "message": row["message"],
                "is_last_good": bool(row["is_last_good"]),
                "is_recovery_point": True,
                "files_changed": self._json_deserialize(row["files_changed_json"]),
                "timestamp": row["timestamp"],
            }
            for row in rows
        ]

    def mark_last_good(self, commit_hash: str) -> bool:
        """Mark a commit as the last known good commit.

        Args:
            commit_hash: Git commit hash to mark

        Returns:
            True if commit was found and marked, False otherwise
        """
        task_id = self.task_id
        if not task_id:
            return False

        with self.db.transaction() as conn:
            # Clear previous last_good flags
            conn.execute(
                "UPDATE build_commits SET is_last_good = 0 WHERE task_id = ?",
                (task_id,)
            )

            # Set new last_good
            cursor = conn.execute(
                """UPDATE build_commits SET is_last_good = 1
                   WHERE task_id = ? AND commit_hash = ?""",
                (task_id, commit_hash)
            )
            return cursor.rowcount > 0

    def clear_history(self) -> int:
        """Clear all recovery data for this task.

        Returns:
            Number of records deleted
        """
        task_id = self.task_id
        if not task_id:
            return 0

        count = 0
        with self.db.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM attempt_history WHERE task_id = ?",
                (task_id,)
            )
            count += cursor.rowcount

            cursor = conn.execute(
                "DELETE FROM build_commits WHERE task_id = ?",
                (task_id,)
            )
            count += cursor.rowcount

        return count
