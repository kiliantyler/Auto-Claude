"""
Task Logs Repository
====================

Provides database operations for task logging.
Replaces JSON file-based storage with SQLite.
"""

import json
from datetime import datetime
from typing import Any, Optional

from ..connection import DatabaseConnection


class TaskLogsRepository:
    """Repository for task logs database operations.

    Manages the storage and retrieval of task logs in SQLite.
    This replaces the task_logs.json file and session log files.
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

    def log(
        self,
        message: str,
        log_type: str = "info",
        subtask_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        session_id: Optional[str] = None,
        details: Optional[dict] = None
    ) -> int:
        """Add a log entry.

        Args:
            message: Log message
            log_type: Type of log (info, warning, error, debug, agent, tool)
            subtask_id: Optional subtask ID this log relates to
            agent_name: Name of the agent that generated the log
            session_id: Session ID for grouping logs
            details: Additional details as dictionary

        Returns:
            ID of the created log entry
        """
        task_id = self.task_id
        if not task_id:
            raise ValueError(f"Task not found for spec_id: {self.spec_id}")

        with self.db.transaction() as conn:
            cursor = conn.execute(
                """INSERT INTO task_logs
                   (task_id, subtask_id, log_type, message, details_json,
                    agent_name, session_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    subtask_id,
                    log_type,
                    message,
                    self._json_serialize(details),
                    agent_name,
                    session_id,
                )
            )
            return cursor.lastrowid

    def info(self, message: str, **kwargs) -> int:
        """Log an info message."""
        return self.log(message, log_type="info", **kwargs)

    def warning(self, message: str, **kwargs) -> int:
        """Log a warning message."""
        return self.log(message, log_type="warning", **kwargs)

    def error(self, message: str, **kwargs) -> int:
        """Log an error message."""
        return self.log(message, log_type="error", **kwargs)

    def debug(self, message: str, **kwargs) -> int:
        """Log a debug message."""
        return self.log(message, log_type="debug", **kwargs)

    def agent(self, message: str, agent_name: str, **kwargs) -> int:
        """Log an agent message."""
        return self.log(message, log_type="agent", agent_name=agent_name, **kwargs)

    def tool(self, message: str, tool_name: str, **kwargs) -> int:
        """Log a tool invocation."""
        details = kwargs.pop("details", {}) or {}
        details["tool_name"] = tool_name
        return self.log(message, log_type="tool", details=details, **kwargs)

    def get_logs(
        self,
        log_type: Optional[str] = None,
        subtask_id: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: int = 0
    ) -> list[dict]:
        """Get logs with optional filtering.

        Args:
            log_type: Filter by log type
            subtask_id: Filter by subtask ID
            session_id: Filter by session ID
            limit: Maximum number of logs to return
            offset: Number of logs to skip

        Returns:
            List of log entries
        """
        task_id = self.task_id
        if not task_id:
            return []

        conditions = ["task_id = ?"]
        params: list[Any] = [task_id]

        if log_type:
            conditions.append("log_type = ?")
            params.append(log_type)

        if subtask_id:
            conditions.append("subtask_id = ?")
            params.append(subtask_id)

        if session_id:
            conditions.append("session_id = ?")
            params.append(session_id)

        where_clause = " AND ".join(conditions)
        sql = f"""SELECT * FROM task_logs
                  WHERE {where_clause}
                  ORDER BY timestamp DESC"""

        if limit:
            sql += f" LIMIT {limit}"
        if offset:
            sql += f" OFFSET {offset}"

        rows = self.db.fetch_all(sql, tuple(params))

        return [
            {
                "id": row["id"],
                "task_id": row["task_id"],
                "subtask_id": row["subtask_id"],
                "log_type": row["log_type"],
                "message": row["message"],
                "details": self._json_deserialize(row["details_json"]),
                "agent_name": row["agent_name"],
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
            }
            for row in rows
        ]

    def get_recent_logs(self, count: int = 50) -> list[dict]:
        """Get the most recent logs.

        Args:
            count: Number of logs to return

        Returns:
            List of log entries (newest first)
        """
        return self.get_logs(limit=count)

    def get_errors(self, limit: Optional[int] = None) -> list[dict]:
        """Get error logs.

        Args:
            limit: Maximum number of errors to return

        Returns:
            List of error log entries
        """
        return self.get_logs(log_type="error", limit=limit)

    def get_session_logs(self, session_id: str) -> list[dict]:
        """Get all logs for a specific session.

        Args:
            session_id: Session ID

        Returns:
            List of log entries for the session
        """
        return self.get_logs(session_id=session_id)

    def get_subtask_logs(self, subtask_id: str) -> list[dict]:
        """Get all logs for a specific subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            List of log entries for the subtask
        """
        return self.get_logs(subtask_id=subtask_id)

    def count_logs(
        self,
        log_type: Optional[str] = None,
        session_id: Optional[str] = None
    ) -> int:
        """Count logs with optional filtering.

        Args:
            log_type: Filter by log type
            session_id: Filter by session ID

        Returns:
            Number of matching logs
        """
        task_id = self.task_id
        if not task_id:
            return 0

        conditions = ["task_id = ?"]
        params: list[Any] = [task_id]

        if log_type:
            conditions.append("log_type = ?")
            params.append(log_type)

        if session_id:
            conditions.append("session_id = ?")
            params.append(session_id)

        where_clause = " AND ".join(conditions)
        row = self.db.fetch_one(
            f"SELECT COUNT(*) as count FROM task_logs WHERE {where_clause}",
            tuple(params)
        )
        return row["count"] if row else 0

    def count_errors(self) -> int:
        """Count error logs."""
        return self.count_logs(log_type="error")

    def clear_logs(self, session_id: Optional[str] = None) -> int:
        """Clear logs, optionally only for a specific session.

        Args:
            session_id: Optional session ID to clear logs for

        Returns:
            Number of logs deleted
        """
        task_id = self.task_id
        if not task_id:
            return 0

        with self.db.transaction() as conn:
            if session_id:
                cursor = conn.execute(
                    "DELETE FROM task_logs WHERE task_id = ? AND session_id = ?",
                    (task_id, session_id)
                )
            else:
                cursor = conn.execute(
                    "DELETE FROM task_logs WHERE task_id = ?",
                    (task_id,)
                )
            return cursor.rowcount

    def get_log_summary(self) -> dict:
        """Get a summary of logs by type.

        Returns:
            Dictionary with counts by log type
        """
        task_id = self.task_id
        if not task_id:
            return {}

        rows = self.db.fetch_all(
            """SELECT log_type, COUNT(*) as count
               FROM task_logs WHERE task_id = ?
               GROUP BY log_type""",
            (task_id,)
        )

        return {row["log_type"]: row["count"] for row in rows}

    def search_logs(self, query: str, limit: int = 50) -> list[dict]:
        """Search logs by message content.

        Args:
            query: Search query
            limit: Maximum number of results

        Returns:
            List of matching log entries
        """
        task_id = self.task_id
        if not task_id:
            return []

        rows = self.db.fetch_all(
            """SELECT * FROM task_logs
               WHERE task_id = ? AND message LIKE ?
               ORDER BY timestamp DESC
               LIMIT ?""",
            (task_id, f"%{query}%", limit)
        )

        return [
            {
                "id": row["id"],
                "task_id": row["task_id"],
                "subtask_id": row["subtask_id"],
                "log_type": row["log_type"],
                "message": row["message"],
                "details": self._json_deserialize(row["details_json"]),
                "agent_name": row["agent_name"],
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
            }
            for row in rows
        ]
