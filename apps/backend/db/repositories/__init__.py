"""
Database Repositories for Auto-Claude Backend
==============================================

Provides repository classes for accessing and modifying database entities.
Each repository encapsulates the data access logic for a specific domain.

Usage:
    from db import get_db_connection
    from db.repositories import ImplementationPlanRepository

    db = get_db_connection()
    repo = ImplementationPlanRepository(db, spec_id="001-feature")
    plan = repo.load()
    plan.phases[0].subtasks[0].status = SubtaskStatus.COMPLETED
    repo.save(plan)
"""

from .implementation_plan import ImplementationPlanRepository
from .recovery import RecoveryRepository
from .task_logs import TaskLogsRepository

__all__ = [
    "ImplementationPlanRepository",
    "RecoveryRepository",
    "TaskLogsRepository",
]
