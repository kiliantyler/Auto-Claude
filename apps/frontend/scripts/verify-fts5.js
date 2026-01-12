#!/usr/bin/env node
/**
 * Verify FTS5 is enabled in SQLite compilation
 * =============================================
 *
 * This script checks if the better-sqlite3 module has FTS5 support
 * which is required for the full-text search feature in Phase 4B.
 *
 * Run with: npm run verify:fts5
 *
 * Expected output:
 * - SQLite version: 3.51.2 (or similar)
 * - FTS5 enabled: YES
 * - All FTS5 checks PASSED
 *
 * NOTE: better-sqlite3 v9.0.0+ includes FTS5 by default in its bundled SQLite.
 * If FTS5 is not available, try running: npm run rebuild
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function success(message) {
  log(`✓ ${message}`, GREEN);
}

function error(message) {
  log(`✗ ${message}`, RED);
}

function info(message) {
  log(`ℹ ${message}`, YELLOW);
}

// Create a temporary database for testing
const tempDbPath = path.join(os.tmpdir(), `fts5-verify-${Date.now()}.db`);

try {
  log(`${BOLD}=== SQLite FTS5 Verification ===${RESET}\n`);

  const db = new Database(tempDbPath);

  // Get SQLite version
  const versionResult = db.prepare('SELECT sqlite_version() as version').get();
  info(`SQLite version: ${versionResult.version}`);

  // Check if FTS5 is compiled in
  const fts5Result = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') as enabled").get();
  const fts5Enabled = fts5Result.enabled === 1;

  if (fts5Enabled) {
    success('FTS5 compile option: ENABLED');
  } else {
    error('FTS5 compile option: DISABLED');
    error('\nFTS5 is NOT enabled in this SQLite compilation!');
    info('Try running: npm run rebuild');
    process.exit(1);
  }

  // Check other relevant compile options
  const fts4Result = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS4') as enabled").get();
  const json1Result = db.prepare("SELECT sqlite_compileoption_used('ENABLE_JSON1') as enabled").get();

  if (fts4Result.enabled === 1) {
    success('FTS4 compile option: ENABLED');
  }
  if (json1Result.enabled === 1) {
    success('JSON1 compile option: ENABLED');
  }

  // Test FTS5 functionality
  console.log('\n--- Functional Tests ---\n');

  // Create test FTS5 table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts5_test USING fts5(title, content);
    INSERT INTO fts5_test VALUES ('Test Title', 'This is test content for FTS5 verification');
    INSERT INTO fts5_test VALUES ('Another Doc', 'More content to search through');
  `);
  success('FTS5 virtual table created');

  // Test basic search
  const searchResult = db.prepare(`
    SELECT title FROM fts5_test WHERE fts5_test MATCH 'test'
  `).get();

  if (searchResult) {
    success(`FTS5 MATCH query works (found: "${searchResult.title}")`);
  } else {
    error('FTS5 MATCH query failed');
    process.exit(1);
  }

  // Test highlight function
  const highlightResult = db.prepare(`
    SELECT highlight(fts5_test, 1, '<mark>', '</mark>') as highlighted
    FROM fts5_test WHERE fts5_test MATCH 'content'
  `).get();

  if (highlightResult && highlightResult.highlighted.includes('<mark>')) {
    success(`highlight() function works`);
  } else {
    error('highlight() function failed');
    process.exit(1);
  }

  // Test bm25 ranking
  const bm25Result = db.prepare(`
    SELECT title, bm25(fts5_test) as rank
    FROM fts5_test WHERE fts5_test MATCH 'content'
    ORDER BY rank
  `).all();

  if (bm25Result && bm25Result.length > 0) {
    success(`bm25() ranking function works (score: ${bm25Result[0].rank.toFixed(4)})`);
  } else {
    error('bm25() ranking function failed');
    process.exit(1);
  }

  // Test snippet function
  const snippetResult = db.prepare(`
    SELECT snippet(fts5_test, 1, '<b>', '</b>', '...', 10) as snippet
    FROM fts5_test WHERE fts5_test MATCH 'verification'
  `).get();

  if (snippetResult) {
    success(`snippet() function works`);
  } else {
    error('snippet() function failed');
    process.exit(1);
  }

  // Clean up
  db.exec('DROP TABLE fts5_test');
  db.close();
  fs.unlinkSync(tempDbPath);

  // Also clean up WAL files if they exist
  try {
    fs.unlinkSync(tempDbPath + '-wal');
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
    /* ignore */
  }

  console.log(`\n${BOLD}${GREEN}=== All FTS5 Verification Checks PASSED ===${RESET}\n`);
  info('FTS5 is fully functional and ready for use with Phase 4B search features.');
  process.exit(0);

} catch (err) {
  error(`\nERROR during FTS5 verification: ${err.message}`);

  // Clean up temp file if it exists
  try {
    fs.unlinkSync(tempDbPath);
    fs.unlinkSync(tempDbPath + '-wal');
    fs.unlinkSync(tempDbPath + '-shm');
  } catch {
    // Ignore cleanup errors
  }

  process.exit(1);
}
