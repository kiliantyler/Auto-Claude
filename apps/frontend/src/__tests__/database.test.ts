/**
 * Unit tests for Database Connection
 * Tests DatabaseConnection class for connection management and transactions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import { DatabaseConnection } from '../main/database';

describe('DatabaseConnection', () => {
  let testDbPath: string;
  let dbConn: DatabaseConnection;

  beforeEach(() => {
    // Create unique test database path
    testDbPath = path.join(
      '/tmp',
      `test-db-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );
    dbConn = new DatabaseConnection(testDbPath);
  });

  afterEach(() => {
    // Clean up database connection and file
    dbConn.close();

    if (existsSync(testDbPath)) {
      try {
        rmSync(testDbPath, { force: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Clean up WAL files if they exist
    [testDbPath + '-wal', testDbPath + '-shm'].forEach((file) => {
      if (existsSync(file)) {
        try {
          rmSync(file, { force: true });
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('constructor', () => {
    it('should accept custom database path', () => {
      const customPath = '/tmp/custom.db';
      const conn = new DatabaseConnection(customPath);

      expect(conn.getPath()).toBe(customPath);
      conn.close();
    });

    it('should create database directory if it does not exist', () => {
      const nonExistentDir = path.join(
        '/tmp',
        `non-existent-${Date.now()}`,
        'db',
        'test.db'
      );
      const conn = new DatabaseConnection(nonExistentDir);

      // Getting connection should create directory structure
      const db = conn.getConnection();
      expect(db).toBeDefined();

      conn.close();

      // Clean up
      if (existsSync(nonExistentDir)) {
        const dirPath = path.dirname(nonExistentDir);
        rmSync(dirPath, { recursive: true, force: true });
      }
    });
  });

  describe('getConnection', () => {
    it('should create database connection on first access', () => {
      const db = dbConn.getConnection();

      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
    });

    it('should reuse connection on subsequent calls', () => {
      const db1 = dbConn.getConnection();
      const db2 = dbConn.getConnection();

      expect(db1).toBe(db2);
    });

    it('should enable foreign key constraints', () => {
      const db = dbConn.getConnection();

      const result = db.pragma('foreign_keys', { simple: true });
      expect(result).toBe(1);
    });

    it('should use WAL mode for journal', () => {
      const db = dbConn.getConnection();

      const result = db.pragma('journal_mode', { simple: true });
      expect(result).toBe('wal');
    });

    it('should set synchronous mode to NORMAL', () => {
      const db = dbConn.getConnection();

      const result = db.pragma('synchronous', { simple: true });
      expect(result).toBe(1); // NORMAL = 1
    });

    it('should create database file on disk', () => {
      dbConn.getConnection();

      expect(existsSync(testDbPath)).toBe(true);
    });
  });

  describe('withTransaction', () => {
    beforeEach(() => {
      // Create test table
      const db = dbConn.getConnection();
      db.exec(`
        CREATE TABLE test_table (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    });

    it('should execute function within transaction', () => {
      const result = dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('test1');
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('test2');
        return 'success';
      });

      expect(result).toBe('success');

      // Verify data was committed
      const db = dbConn.getConnection();
      const rows = db.prepare('SELECT * FROM test_table').all();
      expect(rows).toHaveLength(2);
    });

    it('should commit on successful execution', () => {
      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('test');
      });

      const db = dbConn.getConnection();
      const count = db.prepare('SELECT COUNT(*) as count FROM test_table').get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    });

    it('should rollback on error', () => {
      try {
        dbConn.withTransaction(() => {
          const db = dbConn.getConnection();
          db.prepare('INSERT INTO test_table (value) VALUES (?)').run('test1');
          // This should cause an error (duplicate primary key)
          db.prepare('INSERT INTO test_table (id, value) VALUES (?, ?)').run(1, 'test2');
          db.prepare('INSERT INTO test_table (id, value) VALUES (?, ?)').run(1, 'test3');
        });
      } catch (error) {
        // Expected error
      }

      // Verify rollback - should have either 0 or 1 row (before the error)
      const db = dbConn.getConnection();
      const count = db.prepare('SELECT COUNT(*) as count FROM test_table').get() as {
        count: number;
      };
      // Transaction should rollback, so we expect 0 rows
      expect(count.count).toBe(0);
    });

    it('should throw error from transaction function', () => {
      expect(() => {
        dbConn.withTransaction(() => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');
    });

    it('should handle nested operations atomically', () => {
      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('row1');
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('row2');
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('row3');
      });

      const db = dbConn.getConnection();
      const count = db.prepare('SELECT COUNT(*) as count FROM test_table').get() as {
        count: number;
      };
      expect(count.count).toBe(3);
    });

    it('should return transaction result', () => {
      const result = dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO test_table (value) VALUES (?)').run('test');
        return { success: true, rowCount: 1 };
      });

      expect(result).toEqual({ success: true, rowCount: 1 });
    });
  });

  describe('close', () => {
    it('should close database connection', () => {
      dbConn.getConnection();
      dbConn.close();

      // After closing, getConnection should create new connection
      const newDb = dbConn.getConnection();
      expect(newDb).toBeDefined();
    });

    it('should be safe to call multiple times', () => {
      dbConn.getConnection();

      expect(() => {
        dbConn.close();
        dbConn.close();
        dbConn.close();
      }).not.toThrow();
    });

    it('should allow reconnection after close', () => {
      const db1 = dbConn.getConnection();
      dbConn.close();
      const db2 = dbConn.getConnection();

      expect(db2).toBeDefined();
      expect(db1).not.toBe(db2);
    });
  });

  describe('getPath', () => {
    it('should return database file path', () => {
      expect(dbConn.getPath()).toBe(testDbPath);
    });
  });

  describe('concurrent operations', () => {
    beforeEach(() => {
      const db = dbConn.getConnection();
      db.exec(`
        CREATE TABLE concurrent_test (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          value TEXT NOT NULL
        )
      `);
    });

    it('should handle multiple sequential transactions', () => {
      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO concurrent_test (value) VALUES (?)').run('tx1');
      });

      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO concurrent_test (value) VALUES (?)').run('tx2');
      });

      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO concurrent_test (value) VALUES (?)').run('tx3');
      });

      const db = dbConn.getConnection();
      const count = db.prepare('SELECT COUNT(*) as count FROM concurrent_test').get() as {
        count: number;
      };
      expect(count.count).toBe(3);
    });

    it('should maintain data integrity across transactions', () => {
      // First transaction
      dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        db.prepare('INSERT INTO concurrent_test (value) VALUES (?)').run('value1');
      });

      // Second transaction (should see first transaction's data)
      const result = dbConn.withTransaction(() => {
        const db = dbConn.getConnection();
        const count = db.prepare('SELECT COUNT(*) as count FROM concurrent_test').get() as {
          count: number;
        };
        db.prepare('INSERT INTO concurrent_test (value) VALUES (?)').run('value2');
        return count.count;
      });

      expect(result).toBe(1);

      const db = dbConn.getConnection();
      const finalCount = db.prepare('SELECT COUNT(*) as count FROM concurrent_test').get() as {
        count: number;
      };
      expect(finalCount.count).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should handle SQL syntax errors', () => {
      expect(() => {
        const db = dbConn.getConnection();
        db.prepare('INVALID SQL QUERY').run();
      }).toThrow();
    });

    it('should handle constraint violations', () => {
      const db = dbConn.getConnection();
      db.exec(`
        CREATE TABLE constraint_test (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL UNIQUE
        )
      `);

      db.prepare('INSERT INTO constraint_test (id, value) VALUES (?, ?)').run(1, 'test');

      expect(() => {
        // Try to insert duplicate value
        db.prepare('INSERT INTO constraint_test (id, value) VALUES (?, ?)').run(2, 'test');
      }).toThrow();
    });

    it('should handle foreign key violations when enabled', () => {
      const db = dbConn.getConnection();

      db.exec(`
        CREATE TABLE parent (
          id INTEGER PRIMARY KEY
        );
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES parent(id)
        );
      `);

      expect(() => {
        // Try to insert child without parent (foreign key violation)
        db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run(1, 999);
      }).toThrow();
    });
  });
});
