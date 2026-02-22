import { describe, it, expect, afterAll } from 'vitest';
import { getDb, run, get, all, prepare, transaction, close } from '../db.js';

const TEST_PREFIX = '__test_db_';

describe('db', () => {
  afterAll(async () => {
    const db = getDb();
    db.prepare('DELETE FROM config WHERE key LIKE ?').run(`${TEST_PREFIX}%`);
    close();
  });

  describe('getDb', () => {
    it('возвращает объект Database', () => {
      const db = getDb();
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
    });

    it('возвращает тот же экземпляр (синглтон)', () => {
      const db1 = getDb();
      const db2 = getDb();
      expect(db1).toBe(db2);
    });
  });

  describe('run', () => {
    it('выполняет INSERT, возвращает RunResult с changes: 1', () => {
      const result = run(
        'INSERT INTO config (key, value) VALUES (?, ?)',
        `${TEST_PREFIX}run_test`,
        'value1'
      );
      expect(result).toBeDefined();
      expect(result.changes).toBe(1);
    });
  });

  describe('get', () => {
    it('возвращает одну строку', () => {
      run('INSERT INTO config (key, value) VALUES (?, ?)', `${TEST_PREFIX}get_test`, 'val');
      const row = get('SELECT * FROM config WHERE key = ?', `${TEST_PREFIX}get_test`);
      expect(row).toBeDefined();
      expect(row.key).toBe(`${TEST_PREFIX}get_test`);
      expect(row.value).toBe('val');
    });

    it('undefined для несуществующей строки', () => {
      const row = get('SELECT * FROM config WHERE key = ?', `${TEST_PREFIX}nonexistent_xyz`);
      expect(row).toBeUndefined();
    });
  });

  describe('all', () => {
    it('возвращает массив строк', () => {
      run('INSERT INTO config (key, value) VALUES (?, ?)', `${TEST_PREFIX}all_1`, 'a');
      run('INSERT INTO config (key, value) VALUES (?, ?)', `${TEST_PREFIX}all_2`, 'b');
      const rows = all('SELECT * FROM config WHERE key LIKE ? ORDER BY key', `${TEST_PREFIX}all_%`);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const testRows = rows.filter((r) => r.key.startsWith(TEST_PREFIX));
      expect(testRows.length).toBeGreaterThanOrEqual(2);
    });

    it('пустой массив для пустой выборки', () => {
      const rows = all('SELECT * FROM config WHERE key = ?', `${TEST_PREFIX}empty_nonexistent`);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toEqual([]);
    });
  });

  describe('prepare', () => {
    it('возвращает Statement с методом .get()', () => {
      run('INSERT INTO config (key, value) VALUES (?, ?)', `${TEST_PREFIX}prepare_test`, 'pval');
      const stmt = prepare('SELECT * FROM config WHERE key = ?');
      expect(stmt).toBeDefined();
      expect(typeof stmt.get).toBe('function');
      const row = stmt.get(`${TEST_PREFIX}prepare_test`);
      expect(row).toBeDefined();
      expect(row.value).toBe('pval');
    });
  });

  describe('transaction', () => {
    it('выполняет операции атомарно', () => {
      const key1 = `${TEST_PREFIX}tx_1`;
      const key2 = `${TEST_PREFIX}tx_2`;
      getDb().prepare('DELETE FROM config WHERE key IN (?, ?)').run(key1, key2);

      transaction(() => {
        run('INSERT INTO config (key, value) VALUES (?, ?)', key1, 'v1');
        run('INSERT INTO config (key, value) VALUES (?, ?)', key2, 'v2');
      });

      expect(get('SELECT * FROM config WHERE key = ?', key1)).toBeDefined();
      expect(get('SELECT * FROM config WHERE key = ?', key2)).toBeDefined();
    });
  });

  describe('close', () => {
    it('закрывает БД и обнуляет синглтон', () => {
      const dbBefore = getDb();
      close();
      const dbAfter = getDb();
      expect(dbAfter).toBeDefined();
      expect(dbAfter).not.toBe(dbBefore);
      expect(typeof dbAfter.prepare).toBe('function');
    });
  });
});
