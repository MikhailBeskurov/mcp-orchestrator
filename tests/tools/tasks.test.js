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
import { register } from '../../tools/tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/tasks', () => {
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

  describe('task_create', () => {
    it('основной сценарий — создаёт задачу, возвращает id и status: pending', async () => {
      const res = await mockServer.callTool('task_create', {
        title: 'Тест',
        assigned_to: 'executor_1',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.status).toBe('pending');
      expect(typeof data.id).toBe('number');
    });

    it('с files и depends_on', async () => {
      const res1 = await mockServer.callTool('task_create', {
        title: 'Задача 1',
        assigned_to: 'executor_1',
      });
      const { id } = parseResponse(res1);

      const res2 = await mockServer.callTool('task_create', {
        title: 'Задача 2',
        assigned_to: 'executor_2',
        files: ['a.js', 'b.js'],
        depends_on: [id],
      });
      expect(res2.isError).toBeUndefined();
      const data = parseResponse(res2);
      expect(data).toHaveProperty('id');
      expect(data.status).toBe('pending');
    });

    it('ошибка: несуществующие зависимости → isError', async () => {
      const res = await mockServer.callTool('task_create', {
        title: 'Тест',
        assigned_to: 'executor_1',
        depends_on: [999, 1000],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Несуществующие задачи-зависимости');
    });

    it('ошибка: несуществующая сессия → isError', async () => {
      const res = await mockServer.callTool('task_create', {
        title: 'Тест',
        assigned_to: 'executor_1',
        session_id: 99999,
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Сессия');
      expect(text).toContain('не найдена');
    });

    it('без опциональных полей', async () => {
      const res = await mockServer.callTool('task_create', {
        title: 'Минимальная задача',
        assigned_to: 'reviewer_impl',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBeGreaterThan(0);
      expect(data.status).toBe('pending');
    });

    it('с валидным session_id', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal) VALUES (?)').run('Тестовая сессия');
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('task_create', {
        title: 'Задача сессии',
        assigned_to: 'executor_1',
        session_id: sessionId,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBeGreaterThan(0);
      expect(data.status).toBe('pending');

      const row = dbState.db.prepare('SELECT session_id FROM tasks WHERE id = ?').get(data.id);
      expect(row.session_id).toBe(sessionId);
    });
  });

  describe('task_list', () => {
    it('все задачи без фильтров', async () => {
      await mockServer.callTool('task_create', { title: 'A', assigned_to: 'executor_1' });
      await mockServer.callTool('task_create', { title: 'B', assigned_to: 'executor_2' });

      const res = await mockServer.callTool('task_list', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(2);
    });

    it('фильтр по status', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'A', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);
      await mockServer.callTool('task_update', { id, status: 'done' });
      await mockServer.callTool('task_create', { title: 'B', assigned_to: 'executor_1' });

      const res = await mockServer.callTool('task_list', { status: 'done' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('done');
    });

    it('фильтр по assigned_to', async () => {
      await mockServer.callTool('task_create', { title: 'A', assigned_to: 'executor_1' });
      await mockServer.callTool('task_create', { title: 'B', assigned_to: 'executor_2' });

      const res = await mockServer.callTool('task_list', { assigned_to: 'executor_2' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].assigned_to).toBe('executor_2');
    });

    it('несколько фильтров одновременно', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'A', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);
      await mockServer.callTool('task_update', { id, status: 'in_progress' });
      await mockServer.callTool('task_create', { title: 'B', assigned_to: 'executor_1' });

      const res = await mockServer.callTool('task_list', {
        status: 'in_progress',
        assigned_to: 'executor_1',
      });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe('A');
    });

    it('пустой результат', async () => {
      const res = await mockServer.callTool('task_list', { status: 'done' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });

    it('фильтр по session_id', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal) VALUES (?)').run('Тестовая сессия');
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      await mockServer.callTool('task_create', {
        title: 'A',
        assigned_to: 'executor_1',
        session_id: sessionId,
      });
      await mockServer.callTool('task_create', { title: 'B', assigned_to: 'executor_1' });

      const res = await mockServer.callTool('task_list', { session_id: sessionId });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe('A');
    });
  });

  describe('task_update', () => {
    it('обновляет статус → возвращает задачу', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);

      const res = await mockServer.callTool('task_update', { id, status: 'done' });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.status).toBe('done');
      expect(task.id).toBe(id);
    });

    it('обновляет статус с result', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);

      const res = await mockServer.callTool('task_update', {
        id,
        status: 'failed',
        result: 'Ошибка сборки',
      });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.status).toBe('failed');
      expect(task.result).toBe('Ошибка сборки');
    });

    it('без result — не затирает существующий result', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);
      await mockServer.callTool('task_update', { id, status: 'in_progress', result: 'Старт' });

      const res = await mockServer.callTool('task_update', { id, status: 'done' });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.status).toBe('done');
      expect(task.result).toBe('Старт');
    });

    it('ошибка: задача не найдена → isError', async () => {
      const res = await mockServer.callTool('task_update', {
        id: 99999,
        status: 'done',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });
  });

  describe('task_get', () => {
    it('возвращает задачу с reviews и messages (пустые)', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);

      const res = await mockServer.callTool('task_get', { id });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.id).toBe(id);
      expect(task.reviews).toEqual([]);
      expect(task.messages).toEqual([]);
    });

    it('возвращает задачу с привязанными reviews', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const { id } = parseResponse(r1);

      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, priority) VALUES (?, 'reviewer_impl', 'Замечание', 'normal')`
        )
        .run(id);

      const res = await mockServer.callTool('task_get', { id });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.reviews.length).toBe(1);
      expect(task.reviews[0].description).toBe('Замечание');
    });

    it('ошибка: задача не найдена → isError', async () => {
      const res = await mockServer.callTool('task_get', { id: 99999 });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('возвращает files и depends_on как массивы (parseTask)', async () => {
      const r1 = await mockServer.callTool('task_create', {
        title: 'Зависимость',
        assigned_to: 'executor_1',
      });
      const depId = parseResponse(r1).id;

      const r2 = await mockServer.callTool('task_create', {
        title: 'Основная',
        assigned_to: 'executor_1',
        files: ['a.js', 'b.js'],
        depends_on: [depId],
      });
      const taskId = parseResponse(r2).id;

      const res = await mockServer.callTool('task_get', { id: taskId });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(Array.isArray(task.files)).toBe(true);
      expect(task.files).toEqual(['a.js', 'b.js']);
      expect(Array.isArray(task.depends_on)).toBe(true);
      expect(task.depends_on).toEqual([depId]);
    });

    it('возвращает messages из БД', async () => {
      const r1 = await mockServer.callTool('task_create', { title: 'T', assigned_to: 'executor_1' });
      const taskId = parseResponse(r1).id;

      dbState.db
        .prepare(
          `INSERT INTO messages (from_agent, to_agent, task_id, content) VALUES ('executor_1', 'reviewer_impl', ?, 'Сообщение 1')`
        )
        .run(taskId);
      dbState.db
        .prepare(
          `INSERT INTO messages (from_agent, to_agent, task_id, content) VALUES ('reviewer_impl', 'executor_1', ?, 'Сообщение 2')`
        )
        .run(taskId);

      const res = await mockServer.callTool('task_get', { id: taskId });
      expect(res.isError).toBeUndefined();
      const task = parseResponse(res);
      expect(task.messages.length).toBe(2);
      expect(task.messages[0].content).toBe('Сообщение 1');
      expect(task.messages[1].content).toBe('Сообщение 2');
    });
  });
});
