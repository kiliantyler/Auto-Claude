"""
Database Module for Auto-Claude Backend
========================================

Provides SQLite database connectivity and repository pattern for task storage.
The database is shared with the Electron frontend at <project>/.auto-claude/tasks.db.

Usage:
    from db import get_db_connection, init_db_for_project

    # Initialize database for a project
    db = init_db_for_project(project_dir)

    # Use repositories
    from db.repositories import ImplementationPlanRepository
    repo = ImplementationPlanRepository(db, spec_id="001-feature")
    plan = repo.load()
"""

from .connection import DatabaseConnection, get_db_connection, init_db_for_project

__all__ = [
    "DatabaseConnection",
    "get_db_connection",
    "init_db_for_project",
]
