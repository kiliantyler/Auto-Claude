/**
 * Insights module - modular architecture for AI-powered codebase insights
 *
 * This module provides a clean separation of concerns:
 * - config: Environment and configuration management
 * - paths: Path resolution utilities (legacy, kept for reference)
 * - session-storage: SQLite persistence layer (project-local database)
 * - session-manager: Session lifecycle management
 * - insights-executor: Python process execution
 */

export { InsightsConfig } from './config';
export { InsightsPaths } from './paths';
export { SessionStorage } from './session-storage';
export { SessionManager } from './session-manager';
export { InsightsExecutor } from './insights-executor';
