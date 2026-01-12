/**
 * SQLite Feature Detection Utilities
 * ====================================
 *
 * Utilities for checking SQLite compilation options and feature support.
 *
 * IMPORTANT: better-sqlite3 v9.0.0+ includes FTS5 enabled by default
 * in its bundled SQLite (currently v3.51.2). This verification is for
 * runtime confirmation and debugging purposes.
 *
 * Reference: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/compilation.md
 */

import type Database from 'better-sqlite3';

/**
 * Result of SQLite feature verification
 */
export interface SqliteFeatureResult {
  sqliteVersion: string;
  fts5Enabled: boolean;
  fts4Enabled: boolean;
  fts3Enabled: boolean;
  jsonEnabled: boolean;
  rtreeEnabled: boolean;
}

/**
 * Check if a SQLite compile option is enabled.
 *
 * @param db - Database connection
 * @param option - Compile option name (e.g., 'ENABLE_FTS5')
 * @returns true if the option is enabled
 */
export function checkCompileOption(db: Database.Database, option: string): boolean {
  try {
    const result = db.prepare('SELECT sqlite_compileoption_used(?) as enabled').get(option) as {
      enabled: number;
    };
    return result.enabled === 1;
  } catch (error) {
    console.error(`[SQLite] Error checking compile option ${option}:`, error);
    return false;
  }
}

/**
 * Get the SQLite version string.
 *
 * @param db - Database connection
 * @returns SQLite version string (e.g., "3.51.2")
 */
export function getSqliteVersion(db: Database.Database): string {
  try {
    const result = db.prepare('SELECT sqlite_version() as version').get() as { version: string };
    return result.version;
  } catch (error) {
    console.error('[SQLite] Error getting version:', error);
    return 'unknown';
  }
}

/**
 * Verify FTS5 support by attempting to create a test virtual table.
 *
 * This is a more thorough check that confirms FTS5 actually works,
 * not just that the compile option is present.
 *
 * @param db - Database connection
 * @returns true if FTS5 is fully functional
 */
export function verifyFts5Works(db: Database.Database): boolean {
  const testTableName = `_fts5_verify_${Date.now()}`;

  try {
    // Create a test FTS5 virtual table
    db.exec(`CREATE VIRTUAL TABLE ${testTableName} USING fts5(content)`);

    // Insert test data
    db.prepare(`INSERT INTO ${testTableName} (content) VALUES (?)`).run('test content');

    // Verify search works
    const searchResult = db.prepare(`SELECT * FROM ${testTableName} WHERE ${testTableName} MATCH ?`).get('test');

    // Verify bm25 ranking works
    const bm25Result = db
      .prepare(`SELECT bm25(${testTableName}) as rank FROM ${testTableName} WHERE ${testTableName} MATCH ?`)
      .get('test');

    // Verify highlight works
    const highlightResult = db
      .prepare(`SELECT highlight(${testTableName}, 0, '<b>', '</b>') as hl FROM ${testTableName} WHERE ${testTableName} MATCH ?`)
      .get('test');

    // Clean up
    db.exec(`DROP TABLE ${testTableName}`);

    return !!(searchResult && bm25Result && highlightResult);
  } catch (error) {
    // Clean up on error
    try {
      db.exec(`DROP TABLE IF EXISTS ${testTableName}`);
    } catch {
      // Ignore cleanup errors
    }
    console.error('[SQLite] FTS5 verification failed:', error);
    return false;
  }
}

/**
 * Get a comprehensive feature report for the SQLite database.
 *
 * @param db - Database connection
 * @returns Feature availability report
 */
export function getSqliteFeatures(db: Database.Database): SqliteFeatureResult {
  return {
    sqliteVersion: getSqliteVersion(db),
    fts5Enabled: checkCompileOption(db, 'ENABLE_FTS5'),
    fts4Enabled: checkCompileOption(db, 'ENABLE_FTS4'),
    fts3Enabled: checkCompileOption(db, 'ENABLE_FTS3'),
    jsonEnabled: checkCompileOption(db, 'ENABLE_JSON1'),
    rtreeEnabled: checkCompileOption(db, 'ENABLE_RTREE'),
  };
}

/**
 * Log SQLite features to console for debugging.
 *
 * @param db - Database connection
 */
export function logSqliteFeatures(db: Database.Database): void {
  const features = getSqliteFeatures(db);
  console.log('[SQLite] Feature Report:');
  console.log(`  Version: ${features.sqliteVersion}`);
  console.log(`  FTS5: ${features.fts5Enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`  FTS4: ${features.fts4Enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`  FTS3: ${features.fts3Enabled ? 'Enabled' : 'Disabled'}`);
  console.log(`  JSON1: ${features.jsonEnabled ? 'Enabled' : 'Disabled'}`);
  console.log(`  R-Tree: ${features.rtreeEnabled ? 'Enabled' : 'Disabled'}`);
}

/**
 * Verify FTS5 is available and throw an error if not.
 *
 * This should be called during application startup to ensure
 * FTS5 features will work correctly.
 *
 * @param db - Database connection
 * @throws Error if FTS5 is not available
 */
export function requireFts5(db: Database.Database): void {
  const fts5Enabled = checkCompileOption(db, 'ENABLE_FTS5');

  if (!fts5Enabled) {
    throw new Error(
      '[SQLite] FTS5 is not enabled in this SQLite build. ' +
        'Full-text search features require FTS5. ' +
        'Please ensure better-sqlite3 is properly installed with its bundled SQLite.'
    );
  }

  // Verify FTS5 actually works
  if (!verifyFts5Works(db)) {
    throw new Error(
      '[SQLite] FTS5 compile option is present but FTS5 is not functioning correctly. ' +
        'This may indicate a corrupted installation. Try running: npm run rebuild'
    );
  }

  console.log('[SQLite] FTS5 verified and working correctly');
}
