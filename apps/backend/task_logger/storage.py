"""
Storage functionality for task logs.

Uses SQLite database storage only.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .models import LogEntry, LogPhase


class LogStorage:
    """Handles persistent storage of task logs via SQLite."""

    def __init__(
        self,
        spec_dir: Path,
        project_dir: Optional[Path] = None,
        spec_id: Optional[str] = None
    ):
        """
        Initialize log storage.

        Args:
            spec_dir: Path to the spec directory
            project_dir: Path to project root (for SQLite storage)
            spec_id: Spec ID (derived from spec_dir if not provided)
        """
        self.spec_dir = Path(spec_dir)
        self.spec_id = spec_id or self.spec_dir.name

        # Auto-detect project_dir from spec_dir if not provided
        # Handles both main project and worktree scenarios
        if project_dir is None:
            project_dir = self._detect_project_dir(self.spec_dir)
        self.project_dir = project_dir

        # SQLite repository (lazy-loaded)
        self._logs_repo = None

    def _detect_project_dir(self, spec_dir: Path) -> Optional[Path]:
        """
        Detect the main project directory from spec_dir path.

        Handles:
        - Main project: /path/project/.auto-claude/specs/XXX -> /path/project
        - Worktree: /path/project/.auto-claude/worktrees/tasks/XXX/.auto-claude/specs/XXX
                    -> /path/project (main project, not worktree)

        Returns:
            Path to main project directory, or None if cannot be detected
        """
        spec_dir_str = str(spec_dir.resolve())

        # Check if this is a worktree path
        worktree_marker = "/.auto-claude/worktrees/"
        if worktree_marker in spec_dir_str:
            # Extract main project path (everything before .auto-claude/worktrees/)
            main_project = spec_dir_str.split(worktree_marker)[0]
            return Path(main_project)

        # Standard case: spec_dir is /project/.auto-claude/specs/XXX
        # Go up: XXX -> specs -> .auto-claude -> project
        if ".auto-claude" in spec_dir.parts:
            idx = spec_dir.parts.index(".auto-claude")
            return Path(*spec_dir.parts[:idx])

        return None

    @property
    def logs_repo(self):
        """Get the SQLite task logs repository (lazy-loaded)."""
        if self._logs_repo is None and self.project_dir:
            try:
                from db import init_db_for_project
                from db.repositories import TaskLogsRepository
                db = init_db_for_project(self.project_dir)
                self._logs_repo = TaskLogsRepository(db, self.spec_id)
            except Exception as e:
                print(f"[TASK_LOGS] Warning: Failed to init SQLite: {e}", file=sys.stderr)
        return self._logs_repo

    def _timestamp(self) -> str:
        """Get current timestamp in ISO format."""
        return datetime.now(timezone.utc).isoformat()

    def add_entry(self, entry: LogEntry) -> None:
        """
        Add an entry to the task logs.

        Args:
            entry: The log entry to add
        """
        if not self.logs_repo:
            raise ValueError(
                "[TASK_LOGS] No SQLite repository available. "
                "Ensure project_dir was provided during initialization."
            )

        # Map LogEntry to task_logs table format
        details = {
            "phase": entry.phase,
            "session": entry.session,
            "subtask_id": entry.subtask_id,
            "tool_name": entry.tool_name,
            "tool_input": entry.tool_input,
        }
        self.logs_repo.log(
            message=entry.content,
            log_type=entry.type,
            subtask_id=entry.subtask_id,
            session_id=str(entry.session) if entry.session else None,
            details=details,
        )

    def update_phase_status(
        self, phase: str, status: str, completed_at: str | None = None
    ) -> None:
        """
        Update phase status in SQLite.

        Args:
            phase: Phase name
            status: New status (pending, active, completed, failed)
            completed_at: Optional completion timestamp
        """
        if not self.logs_repo:
            return
        # Phase status is tracked via log entries, not a separate field
        # Log a phase status change entry
        self.logs_repo.log(
            message=f"Phase {phase} status: {status}",
            log_type="phase_status",
            details={"phase": phase, "status": status, "completed_at": completed_at},
        )

    def set_phase_started(self, phase: str, started_at: str) -> None:
        """
        Set phase start time in SQLite.

        Args:
            phase: Phase name
            started_at: Start timestamp
        """
        if not self.logs_repo:
            return
        self.logs_repo.log(
            message=f"Phase {phase} started",
            log_type="phase_start",
            details={"phase": phase, "started_at": started_at},
        )

    def get_logs(self, limit: int = 100) -> list[dict]:
        """Get recent log entries from SQLite."""
        if not self.logs_repo:
            return []
        return self.logs_repo.get_logs(limit=limit)

    def update_spec_id(self, new_spec_id: str) -> None:
        """
        Update the spec ID.

        Args:
            new_spec_id: New spec ID
        """
        self.spec_id = new_spec_id
        # Re-initialize repository with new spec_id
        self._logs_repo = None

    def save(self) -> None:
        """No-op for compatibility - SQLite commits automatically."""
        pass

    def get_data(self) -> dict:
        """
        Get log data structure for compatibility.

        Returns a structure compatible with the old JSON format,
        populated from SQLite where possible.
        """
        from .models import LogPhase

        # Return empty phases structure - phase status is tracked via log entries
        return {
            "spec_id": self.spec_id,
            "created_at": self._timestamp(),
            "updated_at": self._timestamp(),
            "phases": {
                LogPhase.PLANNING.value: {"phase": LogPhase.PLANNING.value, "status": "pending", "entries": []},
                LogPhase.CODING.value: {"phase": LogPhase.CODING.value, "status": "pending", "entries": []},
                LogPhase.VALIDATION.value: {"phase": LogPhase.VALIDATION.value, "status": "pending", "entries": []},
            },
        }

    def get_phase_data(self, phase: str) -> dict:
        """Get data for a specific phase."""
        data = self.get_data()
        return data["phases"].get(phase, {})


def get_active_phase(spec_dir: Path) -> str | None:
    """
    Get the currently active phase for a spec from SQLite.

    Args:
        spec_dir: Path to the spec directory

    Returns:
        Phase name or None if no active phase
    """
    storage = LogStorage(spec_dir)
    if not storage.logs_repo:
        return None

    # Get recent phase status logs
    logs = storage.get_logs(limit=50)
    for log in logs:
        details = log.get("details", {})
        if log.get("log_type") == "phase_status" and details.get("status") == "active":
            return details.get("phase")

    return None
