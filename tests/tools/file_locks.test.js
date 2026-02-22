import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const dbState = vi.hoisted(() => ({ db: null }));

vi.mock('../../db.js', () => ({
  getDb: () => dbState.db,
  run: (sql, ...params) => dbState.db.prepare(sql).run(...params),
  get: (sql, ...params) => dbState.db.prepare(sql).get(...params),
  all: (sql, ...params) => dbState.db.prepare(sql).all(...params),
  prepare: (sql) => dbState.db.prepare(sql),
  transaction: (fn) => dbState.db.transaction(fn)(),
  close: () => {},
}));

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMockServer } from '../helpers/mock-server.js';
import { parseResponse } from '../helpers/parse-response.js';
import { register } from '../../tools/file_locks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/file_locks', () => {
  let mockServer;

  beforeEach(() => {
    setupDb();
    mockServer = createMockServer();
    register(mockServer);
  });

  afterEach(() => {
    if (dbState.db) {
      dbState.db.close();
      dbState.db = null;
    }
  });

  function createTask() {
    dbState.db
      .prepare(
        `INSERT INTO tasks (title, assigned_to, priority) VALUES ('Тест', 'executor_1', 'normal')`
      )
      .run();
    return dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
  }

  describe('file_lock', () => {
    it('основной сценарий — блокирует файл, возвращает данные (file, locked_by, task_id=null, locked_at)', async () => {
      const res = await mockServer.callTool('file_lock', {
        file: 'src/foo.js',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('file', 'src/foo.js');
      expect(data).toHaveProperty('locked_by', 'executor_1');
      expect(data.task_id).toBeNull();
      expect(data).toHaveProperty('locked_at');
      expect(typeof data.locked_at).toBe('string');
    });

    it('с task_id — блокировка привязана к задаче', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('file_lock', {
        file: 'src/bar.js',
        locked_by: 'executor_1',
        task_id: taskId,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.file).toBe('src/bar.js');
      expect(data.locked_by).toBe('executor_1');
      expect(data.task_id).toBe(taskId);
      expect(data).toHaveProperty('locked_at');
    });

    it('идемпотентность — повторная блокировка тем же агентом возвращает существующую, не ошибку', async () => {
      const res1 = await mockServer.callTool('file_lock', {
        file: 'src/same.js',
        locked_by: 'executor_2',
      });
      expect(res1.isError).toBeUndefined();
      const first = parseResponse(res1);

      const res2 = await mockServer.callTool('file_lock', {
        file: 'src/same.js',
        locked_by: 'executor_2',
      });
      expect(res2.isError).toBeUndefined();
      const second = parseResponse(res2);

      expect(second.file).toBe(first.file);
      expect(second.locked_by).toBe(first.locked_by);
      expect(second.locked_at).toBe(first.locked_at);
    });

    it('файл уже заблокирован другим агентом → isError', async () => {
      await mockServer.callTool('file_lock', {
        file: 'src/conflict.js',
        locked_by: 'executor_1',
      });

      const res = await mockServer.callTool('file_lock', {
        file: 'src/conflict.js',
        locked_by: 'executor_2',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('executor_1');
    });

    it('пустой файл из пробелов → isError', async () => {
      const res = await mockServer.callTool('file_lock', {
        file: '   ',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустым');
    });

    it('task_id не существует → isError', async () => {
      const res = await mockServer.callTool('file_lock', {
        file: 'src/foo.js',
        locked_by: 'executor_1',
        task_id: 99999,
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('нормализация файла — пробелы по краям trim()', async () => {
      const res = await mockServer.callTool('file_lock', {
        file: '  src/trimmed.js  ',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.file).toBe('src/trimmed.js');

      const row = dbState.db.prepare('SELECT file FROM file_locks WHERE file = ?').get('src/trimmed.js');
      expect(row).toBeTruthy();
      expect(row.file).toBe('src/trimmed.js');
    });
  });

  describe('file_unlock', () => {
    it('основной сценарий — разблокировка, возвращает { file, unlocked: true }', async () => {
      await mockServer.callTool('file_lock', {
        file: 'src/unlock-me.js',
        locked_by: 'executor_1',
      });

      const res = await mockServer.callTool('file_unlock', {
        file: 'src/unlock-me.js',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual({ file: 'src/unlock-me.js', unlocked: true });
    });

    it('пустой файл из пробелов → isError', async () => {
      const res = await mockServer.callTool('file_unlock', {
        file: '   ',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустым');
    });

    it('файл не заблокирован → isError', async () => {
      const res = await mockServer.callTool('file_unlock', {
        file: 'src/never-locked.js',
        locked_by: 'executor_1',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('заблокирован другим агентом → isError', async () => {
      await mockServer.callTool('file_lock', {
        file: 'src/other-lock.js',
        locked_by: 'executor_1',
      });

      const res = await mockServer.callTool('file_unlock', {
        file: 'src/other-lock.js',
        locked_by: 'executor_2',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('другим агентом');
    });

    it('после разблокировки файл действительно удалён из БД', async () => {
      await mockServer.callTool('file_lock', {
        file: 'src/delete-me.js',
        locked_by: 'reviewer_impl',
      });

      await mockServer.callTool('file_unlock', {
        file: 'src/delete-me.js',
        locked_by: 'reviewer_impl',
      });

      const row = dbState.db.prepare('SELECT file FROM file_locks WHERE file = ?').get('src/delete-me.js');
      expect(row).toBeUndefined();
    });
  });

  describe('file_locks_list', () => {
    it('все блокировки без фильтров', async () => {
      await mockServer.callTool('file_lock', { file: 'a.js', locked_by: 'executor_1' });
      await mockServer.callTool('file_lock', { file: 'b.js', locked_by: 'executor_2' });

      const res = await mockServer.callTool('file_locks_list', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(2);
    });

    it('фильтр по locked_by', async () => {
      await mockServer.callTool('file_lock', { file: 'a.js', locked_by: 'executor_1' });
      await mockServer.callTool('file_lock', { file: 'b.js', locked_by: 'executor_2' });
      await mockServer.callTool('file_lock', { file: 'c.js', locked_by: 'executor_1' });

      const res = await mockServer.callTool('file_locks_list', { locked_by: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.locked_by === 'executor_1')).toBe(true);
    });

    it('фильтр по task_id', async () => {
      const taskId = createTask();
      await mockServer.callTool('file_lock', {
        file: 'task-file.js',
        locked_by: 'executor_1',
        task_id: taskId,
      });
      await mockServer.callTool('file_lock', { file: 'no-task.js', locked_by: 'executor_1' });

      const res = await mockServer.callTool('file_locks_list', { task_id: taskId });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].file).toBe('task-file.js');
      expect(rows[0].task_id).toBe(taskId);
    });

    it('комбинированный фильтр — locked_by и task_id одновременно', async () => {
      const taskId = createTask();
      await mockServer.callTool('file_lock', {
        file: 'match.js',
        locked_by: 'executor_1',
        task_id: taskId,
      });
      await mockServer.callTool('file_lock', {
        file: 'no-match-agent.js',
        locked_by: 'executor_2',
        task_id: taskId,
      });
      await mockServer.callTool('file_lock', { file: 'no-match-task.js', locked_by: 'executor_1' });

      const res = await mockServer.callTool('file_locks_list', {
        locked_by: 'executor_1',
        task_id: taskId,
      });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].file).toBe('match.js');
    });

    it('пустой результат (нет блокировок)', async () => {
      const res = await mockServer.callTool('file_locks_list', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });

    it('несколько блокировок — проверка порядка (ORDER BY locked_at DESC)', async () => {
      dbState.db
        .prepare(
          `INSERT INTO file_locks (file, locked_by, locked_at) VALUES ('a.js', 'executor_1', '2025-01-01 09:00:00')`
        )
        .run();
      dbState.db
        .prepare(
          `INSERT INTO file_locks (file, locked_by, locked_at) VALUES ('b.js', 'executor_1', '2025-01-01 11:00:00')`
        )
        .run();
      dbState.db
        .prepare(
          `INSERT INTO file_locks (file, locked_by, locked_at) VALUES ('c.js', 'executor_1', '2025-01-01 10:00:00')`
        )
        .run();

      const res = await mockServer.callTool('file_locks_list', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(3);
      expect(rows[0].file).toBe('b.js');
      expect(rows[1].file).toBe('c.js');
      expect(rows[2].file).toBe('a.js');
    });
  });
});
