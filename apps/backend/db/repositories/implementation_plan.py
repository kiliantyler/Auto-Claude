"""
Implementation Plan Repository
==============================

Provides database operations for implementation plans, phases, and subtasks.
Replaces JSON file-based storage with SQLite.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from ..connection import DatabaseConnection


class ImplementationPlanRepository:
    """Repository for implementation plan database operations.

    Manages the storage and retrieval of implementation plans,
    including phases and subtasks, in SQLite.

    The repository works with the existing ImplementationPlan, Phase,
    and Subtask dataclasses, converting them to/from database rows.
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
        """Get the task ID for this spec.

        Lazily looks up the task ID from the spec_id.
        """
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

    def load(self) -> Optional["ImplementationPlan"]:
        """Load the implementation plan from the database.

        Returns:
            ImplementationPlan object or None if not found
        """
        # Import here to avoid circular imports
        from implementation_plan.enums import PhaseType, SubtaskStatus, WorkflowType
        from implementation_plan.phase import Phase
        from implementation_plan.plan import ImplementationPlan
        from implementation_plan.subtask import Subtask

        task_id = self.task_id
        if not task_id:
            return None

        # Load task data
        task_row = self.db.fetch_one(
            """SELECT id, spec_id, title, description, status, metadata_json,
                      spec_content, qa_report_content, qa_fix_request_content
               FROM tasks WHERE id = ?""",
            (task_id,)
        )
        if not task_row:
            return None

        # Load phases
        phase_rows = self.db.fetch_all(
            """SELECT id, task_id, phase_number, name, phase_type, description,
                      depends_on_json, status, started_at, completed_at
               FROM implementation_phases
               WHERE task_id = ?
               ORDER BY phase_number""",
            (task_id,)
        )

        # Load subtasks
        subtask_rows = self.db.fetch_all(
            """SELECT id, task_id, phase_id, subtask_number, description, status,
                      files_to_modify_json, files_to_create_json, files_to_reference_json,
                      actual_output, error_message, attempt_count, started_at, completed_at
               FROM implementation_subtasks
               WHERE task_id = ?
               ORDER BY phase_id, subtask_number""",
            (task_id,)
        )

        # Load requirements for additional metadata
        req_row = self.db.fetch_one(
            """SELECT task_description, workflow_type, services_involved_json,
                      acceptance_criteria_json
               FROM task_requirements WHERE task_id = ?""",
            (task_id,)
        )

        # Group subtasks by phase
        subtasks_by_phase: dict[int, list[sqlite3.Row]] = {}
        for sr in subtask_rows:
            phase_id = sr["phase_id"]
            if phase_id not in subtasks_by_phase:
                subtasks_by_phase[phase_id] = []
            subtasks_by_phase[phase_id].append(sr)

        # Build phases with subtasks
        phases = []
        for pr in phase_rows:
            phase_subtasks = subtasks_by_phase.get(pr["id"], [])

            # Convert subtask rows to Subtask objects
            subtask_objs = []
            for sr in phase_subtasks:
                subtask = Subtask(
                    id=sr["id"],
                    description=sr["description"],
                    status=SubtaskStatus(sr["status"]) if sr["status"] else SubtaskStatus.PENDING,
                    files_to_modify=self._json_deserialize(sr["files_to_modify_json"]) or [],
                    files_to_create=self._json_deserialize(sr["files_to_create_json"]) or [],
                    patterns_from=self._json_deserialize(sr["files_to_reference_json"]) or [],
                    actual_output=sr["actual_output"],
                    started_at=sr["started_at"],
                    completed_at=sr["completed_at"],
                )
                subtask_objs.append(subtask)

            # Create Phase object
            phase = Phase(
                phase=pr["phase_number"],
                name=pr["name"],
                type=PhaseType(pr["phase_type"]) if pr["phase_type"] else PhaseType.IMPLEMENTATION,
                subtasks=subtask_objs,
                depends_on=self._json_deserialize(pr["depends_on_json"]) or [],
            )
            phases.append(phase)

        # Parse metadata from task
        metadata = self._json_deserialize(task_row["metadata_json"]) or {}

        # Determine workflow type
        workflow_type = WorkflowType.FEATURE
        if req_row and req_row["workflow_type"]:
            try:
                workflow_type = WorkflowType(req_row["workflow_type"])
            except ValueError:
                pass

        # Build ImplementationPlan
        plan = ImplementationPlan(
            feature=task_row["title"],
            workflow_type=workflow_type,
            services_involved=self._json_deserialize(req_row["services_involved_json"]) if req_row else [],
            phases=phases,
            final_acceptance=self._json_deserialize(req_row["acceptance_criteria_json"]) if req_row else [],
            created_at=metadata.get("created_at"),
            updated_at=metadata.get("updated_at"),
            spec_file=metadata.get("spec_file"),
            status=task_row["status"],
            planStatus=metadata.get("planStatus"),
            recoveryNote=metadata.get("recoveryNote"),
            qa_signoff=metadata.get("qa_signoff"),
        )

        return plan

    def save(self, plan: "ImplementationPlan") -> bool:
        """Save the implementation plan to the database.

        Args:
            plan: ImplementationPlan object to save

        Returns:
            True if saved successfully, False otherwise
        """
        task_id = self.task_id
        if not task_id:
            # Task doesn't exist, try to create it
            task_id = self._create_task(plan)
            if not task_id:
                return False
            self._task_id = task_id

        # Update timestamps
        plan.updated_at = self._now()
        if not plan.created_at:
            plan.created_at = plan.updated_at

        # Update status based on subtasks
        plan.update_status_from_subtasks()

        with self.db.transaction() as conn:
            # Update task metadata
            metadata = {
                "created_at": plan.created_at,
                "updated_at": plan.updated_at,
                "spec_file": plan.spec_file,
                "planStatus": plan.planStatus,
                "recoveryNote": plan.recoveryNote,
                "qa_signoff": plan.qa_signoff,
            }

            conn.execute(
                """UPDATE tasks SET
                       status = ?,
                       metadata_json = ?,
                       updated_at = datetime('now')
                   WHERE id = ?""",
                (plan.status, self._json_serialize(metadata), task_id)
            )

            # Delete existing phases and subtasks (cascade will handle subtasks)
            conn.execute(
                "DELETE FROM implementation_phases WHERE task_id = ?",
                (task_id,)
            )

            # Insert phases
            for phase in plan.phases:
                cursor = conn.execute(
                    """INSERT INTO implementation_phases
                       (task_id, phase_number, name, phase_type, description,
                        depends_on_json, status)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        task_id,
                        phase.phase,
                        phase.name,
                        phase.type.value if phase.type else "implementation",
                        None,  # description
                        self._json_serialize(phase.depends_on) if phase.depends_on else None,
                        "completed" if phase.is_complete() else "in_progress" if any(
                            s.status.value == "in_progress" for s in phase.subtasks
                        ) else "pending"
                    )
                )
                phase_id = cursor.lastrowid

                # Insert subtasks
                for idx, subtask in enumerate(phase.subtasks):
                    conn.execute(
                        """INSERT INTO implementation_subtasks
                           (id, task_id, phase_id, subtask_number, description, status,
                            files_to_modify_json, files_to_create_json, files_to_reference_json,
                            actual_output, started_at, completed_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            subtask.id,
                            task_id,
                            phase_id,
                            idx + 1,
                            subtask.description,
                            subtask.status.value,
                            self._json_serialize(subtask.files_to_modify) if subtask.files_to_modify else None,
                            self._json_serialize(subtask.files_to_create) if subtask.files_to_create else None,
                            self._json_serialize(subtask.patterns_from) if subtask.patterns_from else None,
                            subtask.actual_output,
                            subtask.started_at,
                            subtask.completed_at,
                        )
                    )

            # Update/insert requirements
            conn.execute(
                """INSERT OR REPLACE INTO task_requirements
                   (task_id, task_description, workflow_type, services_involved_json,
                    acceptance_criteria_json, updated_at)
                   VALUES (?, ?, ?, ?, ?, datetime('now'))""",
                (
                    task_id,
                    plan.feature,
                    plan.workflow_type.value,
                    self._json_serialize(plan.services_involved) if plan.services_involved else None,
                    self._json_serialize(plan.final_acceptance) if plan.final_acceptance else None,
                )
            )

        return True

    def _create_task(self, plan: "ImplementationPlan") -> Optional[str]:
        """Create a new task record for the plan.

        Args:
            plan: ImplementationPlan to create task for

        Returns:
            Task ID if created, None otherwise
        """
        # Generate task ID (matches frontend convention)
        task_id = f"task-{self.spec_id}"

        metadata = {
            "created_at": plan.created_at or self._now(),
            "updated_at": self._now(),
            "spec_file": plan.spec_file,
            "planStatus": plan.planStatus or "pending",
        }

        with self.db.transaction() as conn:
            conn.execute(
                """INSERT INTO tasks
                   (id, spec_id, project_id, title, description, status, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    self.spec_id,
                    "",  # project_id will be set by frontend
                    plan.feature,
                    plan.feature,  # Use feature as description initially
                    plan.status or "backlog",
                    self._json_serialize(metadata),
                )
            )

        return task_id

    def update_subtask_status(
        self,
        subtask_id: str,
        status: str,
        actual_output: Optional[str] = None
    ) -> bool:
        """Update the status of a specific subtask.

        This is a convenience method for updating just the status
        without loading/saving the entire plan.

        Args:
            subtask_id: Subtask ID to update
            status: New status value
            actual_output: Optional output/result text

        Returns:
            True if updated, False if subtask not found
        """
        updates = {
            "status": status,
            "updated_at": self._now(),
        }
        if actual_output is not None:
            updates["actual_output"] = actual_output

        if status == "in_progress":
            updates["started_at"] = self._now()
        elif status == "completed":
            updates["completed_at"] = self._now()

        set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
        values = tuple(updates.values()) + (subtask_id,)

        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE implementation_subtasks SET {set_clause} WHERE id = ?",
                values
            )
            return cursor.rowcount > 0

    def get_subtask(self, subtask_id: str) -> Optional[dict]:
        """Get a single subtask by ID.

        Args:
            subtask_id: Subtask ID to fetch

        Returns:
            Dictionary with subtask data or None
        """
        row = self.db.fetch_one(
            """SELECT id, task_id, phase_id, subtask_number, description, status,
                      files_to_modify_json, files_to_create_json, files_to_reference_json,
                      actual_output, error_message, attempt_count, started_at, completed_at
               FROM implementation_subtasks WHERE id = ?""",
            (subtask_id,)
        )
        if not row:
            return None

        return {
            "id": row["id"],
            "description": row["description"],
            "status": row["status"],
            "files_to_modify": self._json_deserialize(row["files_to_modify_json"]),
            "files_to_create": self._json_deserialize(row["files_to_create_json"]),
            "files_to_reference": self._json_deserialize(row["files_to_reference_json"]),
            "actual_output": row["actual_output"],
            "error_message": row["error_message"],
            "attempt_count": row["attempt_count"],
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
        }

    def get_progress(self) -> dict:
        """Get progress statistics for the plan.

        Returns:
            Dictionary with progress stats
        """
        task_id = self.task_id
        if not task_id:
            return {
                "total_phases": 0,
                "completed_phases": 0,
                "total_subtasks": 0,
                "completed_subtasks": 0,
                "failed_subtasks": 0,
                "percent_complete": 0,
                "is_complete": False,
            }

        # Count phases
        phase_row = self.db.fetch_one(
            """SELECT
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
               FROM implementation_phases WHERE task_id = ?""",
            (task_id,)
        )

        # Count subtasks
        subtask_row = self.db.fetch_one(
            """SELECT
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
               FROM implementation_subtasks WHERE task_id = ?""",
            (task_id,)
        )

        total_subtasks = subtask_row["total"] if subtask_row else 0
        completed_subtasks = subtask_row["completed"] if subtask_row else 0
        failed_subtasks = subtask_row["failed"] if subtask_row else 0

        percent = (
            round(100 * completed_subtasks / total_subtasks, 1)
            if total_subtasks > 0 else 0
        )

        return {
            "total_phases": phase_row["total"] if phase_row else 0,
            "completed_phases": phase_row["completed"] if phase_row else 0,
            "total_subtasks": total_subtasks,
            "completed_subtasks": completed_subtasks,
            "failed_subtasks": failed_subtasks,
            "percent_complete": percent,
            "is_complete": completed_subtasks == total_subtasks and failed_subtasks == 0 and total_subtasks > 0,
        }

    def exists(self) -> bool:
        """Check if a plan exists for this spec.

        Returns:
            True if plan exists, False otherwise
        """
        return self.task_id is not None

    def delete(self) -> bool:
        """Delete the plan and all related data.

        Returns:
            True if deleted, False if not found
        """
        task_id = self.task_id
        if not task_id:
            return False

        # CASCADE will handle phases, subtasks, requirements, etc.
        with self.db.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM tasks WHERE id = ?",
                (task_id,)
            )
            return cursor.rowcount > 0

    def save_markdown_content(
        self,
        spec_content: Optional[str] = None,
        qa_report_content: Optional[str] = None,
        qa_fix_request_content: Optional[str] = None
    ) -> bool:
        """Save markdown file content to the database.

        Args:
            spec_content: Content of spec.md
            qa_report_content: Content of qa_report.md
            qa_fix_request_content: Content of QA_FIX_REQUEST.md

        Returns:
            True if saved, False if task not found
        """
        task_id = self.task_id
        if not task_id:
            return False

        updates = []
        values = []

        if spec_content is not None:
            updates.append("spec_content = ?")
            values.append(spec_content)

        if qa_report_content is not None:
            updates.append("qa_report_content = ?")
            values.append(qa_report_content)

        if qa_fix_request_content is not None:
            updates.append("qa_fix_request_content = ?")
            values.append(qa_fix_request_content)

        if not updates:
            return True  # Nothing to update

        updates.append("updated_at = datetime('now')")
        values.append(task_id)

        with self.db.transaction() as conn:
            conn.execute(
                f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?",
                tuple(values)
            )

        return True

    def get_markdown_content(self) -> dict:
        """Get markdown file content from the database.

        Returns:
            Dictionary with spec_content, qa_report_content, qa_fix_request_content
        """
        task_id = self.task_id
        if not task_id:
            return {
                "spec_content": None,
                "qa_report_content": None,
                "qa_fix_request_content": None,
            }

        row = self.db.fetch_one(
            """SELECT spec_content, qa_report_content, qa_fix_request_content
               FROM tasks WHERE id = ?""",
            (task_id,)
        )

        if not row:
            return {
                "spec_content": None,
                "qa_report_content": None,
                "qa_fix_request_content": None,
            }

        return {
            "spec_content": row["spec_content"],
            "qa_report_content": row["qa_report_content"],
            "qa_fix_request_content": row["qa_fix_request_content"],
        }
