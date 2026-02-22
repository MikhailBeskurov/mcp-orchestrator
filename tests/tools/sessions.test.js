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
import { register } from '../../tools/sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/sessions', () => {
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

  describe('session_start', () => {
    it('основной сценарий — создаёт сессию с goal', async () => {
      const res = await mockServer.callTool('session_start', {
        goal: 'Реализовать авторизацию',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.goal).toBe('Реализовать авторизацию');
      expect(data.plan).toBeNull();
      expect(data.status).toBe('active');
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();
    });

    it('с plan — сессия создаётся с plan', async () => {
      const res = await mockServer.callTool('session_start', {
        goal: 'Рефакторинг API',
        plan: '1. Разделить роуты 2. Добавить валидацию',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.goal).toBe('Рефакторинг API');
      expect(data.plan).toBe('1. Разделить роуты 2. Добавить валидацию');
      expect(data.status).toBe('active');
    });

    it('без plan — plan = null в БД', async () => {
      const res = await mockServer.callTool('session_start', {
        goal: 'Цель без плана',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);

      const row = dbState.db.prepare('SELECT plan FROM sessions WHERE id = ?').get(data.id);
      expect(row.plan).toBeNull();
    });

    it('goal с пробелами вокруг — trim работает', async () => {
      const res = await mockServer.callTool('session_start', {
        goal: '  Цель с пробелами  ',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.goal).toBe('Цель с пробелами');
    });

    it('plan из пробелов — сохраняется как null', async () => {
      const res = await mockServer.callTool('session_start', {
        goal: 'Цель',
        plan: '   ',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.plan).toBeNull();

      const row = dbState.db.prepare('SELECT plan FROM sessions WHERE id = ?').get(data.id);
      expect(row.plan).toBeNull();
    });

    it('несколько сессий подряд — автоинкремент ID', async () => {
      const res1 = await mockServer.callTool('session_start', { goal: 'Сессия 1' });
      const res2 = await mockServer.callTool('session_start', { goal: 'Сессия 2' });
      const res3 = await mockServer.callTool('session_start', { goal: 'Сессия 3' });

      const data1 = parseResponse(res1);
      const data2 = parseResponse(res2);
      const data3 = parseResponse(res3);

      expect(data1.id).toBe(1);
      expect(data2.id).toBe(2);
      expect(data3.id).toBe(3);
    });

    it('status по умолчанию = active', async () => {
      const res = await mockServer.callTool('session_start', { goal: 'Проверка статуса' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.status).toBe('active');

      const row = dbState.db.prepare('SELECT status FROM sessions WHERE id = ?').get(data.id);
      expect(row.status).toBe('active');
    });

    it('пустой goal после trim → isError', async () => {
      const res = await mockServer.callTool('session_start', { goal: '   ' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустой');
    });

    it('session_start чистит блокировки от abandoned-сессий', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Заброшенная сессия', null, 'abandoned');
      const abandonedId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?)')
        .run('Задача abandoned', 'executor_1', abandonedId, 'pending');
      const taskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO file_locks (file, locked_by, task_id) VALUES (?, ?, ?)')
        .run('abandoned.js', 'executor_1', taskId);

      const logSpy = vi.spyOn(console, 'log');
      const res = await mockServer.callTool('session_start', { goal: 'Новая сессия' });
      expect(res.isError).toBeUndefined();
      const locks = dbState.db.prepare('SELECT * FROM file_locks').all();
      expect(locks.length).toBe(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[session_start] Очистка orphaned:')
      );
      logSpy.mockRestore();
    });

    it('session_start чистит pending/in_progress задачи от abandoned-сессий', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Заброшенная', null, 'abandoned');
      const abandonedId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
        .run('Pending', 'executor_1', abandonedId, 'pending', 'InProgress', 'executor_2', abandonedId, 'in_progress');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await mockServer.callTool('session_start', { goal: 'Новая' });
      logSpy.mockRestore();

      const tasks = dbState.db.prepare('SELECT * FROM tasks WHERE session_id = ?').all(abandonedId);
      expect(tasks.every((t) => t.status === 'failed' && t.result === 'Orphaned: сессия была abandoned')).toBe(true);
    });

    it('нет abandoned-сессий — сессия создаётся нормально (регрессия)', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const res = await mockServer.callTool('session_start', { goal: 'Обычная сессия' });
      logSpy.mockRestore();

      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.goal).toBe('Обычная сессия');
      expect(data.status).toBe('active');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('session_start возвращает cleanup при наличии orphaned-записей', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Заброшенная', null, 'abandoned');
      const abandonedId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?)')
        .run('Задача', 'executor_1', abandonedId, 'pending');
      const taskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO file_locks (file, locked_by, task_id) VALUES (?, ?, ?)')
        .run('orphan.js', 'executor_1', taskId);

      const res = await mockServer.callTool('session_start', { goal: 'Новая сессия' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('cleanup');
      expect(data.cleanup).toEqual({ unlocked_files: 1, failed_tasks: 1 });
    });

    it('session_start НЕ содержит cleanup при отсутствии orphaned-записей', async () => {
      const res = await mockServer.callTool('session_start', { goal: 'Чистая сессия' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).not.toHaveProperty('cleanup');
    });

    it('задачи со статусом done в abandoned-сессии НЕ затронуты', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Abandoned', null, 'abandoned');
      const abandonedId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status, result) VALUES (?, ?, ?, ?, ?)')
        .run('Готовая задача', 'executor_1', abandonedId, 'done', 'Выполнено');

      await mockServer.callTool('session_start', { goal: 'Новая' });

      const doneTask = dbState.db.prepare('SELECT * FROM tasks WHERE session_id = ? AND status = ?').get(abandonedId, 'done');
      expect(doneTask).toBeDefined();
      expect(doneTask.status).toBe('done');
      expect(doneTask.result).toBe('Выполнено');
    });

    it('бесхозные блокировки (задача без существующей сессии) очищаются', async () => {
      dbState.db.pragma('foreign_keys = OFF');
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?)')
        .run('Orphan task', 'executor_1', 99999, 'pending');
      const orphanTaskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO file_locks (file, locked_by, task_id) VALUES (?, ?, ?)')
        .run('orphan.js', 'executor_1', orphanTaskId);
      dbState.db.pragma('foreign_keys = ON');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await mockServer.callTool('session_start', { goal: 'Новая' });
      logSpy.mockRestore();

      const locks = dbState.db.prepare('SELECT * FROM file_locks WHERE file = ?').all('orphan.js');
      expect(locks.length).toBe(0);
    });
  });

  describe('session_update', () => {
    it('основной сценарий: активная сессия → completed, возвращает объект с cleanup', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Завершаемая сессия' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBe(sessionId);
      expect(data.status).toBe('completed');
      expect(data).toHaveProperty('cleanup');
      expect(data.cleanup).toHaveProperty('unlocked_files');
      expect(data.cleanup).toHaveProperty('failed_tasks');
      expect(data.cleanup.unlocked_files).toBe(0);
      expect(data.cleanup.failed_tasks).toBe(0);
    });

    it('активная сессия → abandoned', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Забрасываемая' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'abandoned' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.status).toBe('abandoned');
      expect(data.cleanup).toBeDefined();
    });

    it('session_update использует разный result для completed и abandoned', async () => {
      const startCompleted = await mockServer.callTool('session_start', { goal: 'Для completed' });
      const sessionIdCompleted = parseResponse(startCompleted).id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?)')
        .run('Задача', 'executor_1', sessionIdCompleted, 'pending');

      await mockServer.callTool('session_update', { id: sessionIdCompleted, status: 'completed' });
      const taskCompleted = dbState.db.prepare('SELECT result FROM tasks WHERE session_id = ?').get(sessionIdCompleted);
      expect(taskCompleted.result).toBe('Сессия завершена (completed)');

      const startAbandoned = await mockServer.callTool('session_start', { goal: 'Для abandoned' });
      const sessionIdAbandoned = parseResponse(startAbandoned).id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?)')
        .run('Задача', 'executor_1', sessionIdAbandoned, 'pending');

      await mockServer.callTool('session_update', { id: sessionIdAbandoned, status: 'abandoned' });
      const taskAbandoned = dbState.db.prepare('SELECT result FROM tasks WHERE session_id = ?').get(sessionIdAbandoned);
      expect(taskAbandoned.result).toBe('Сессия заброшена (abandoned)');
    });

    it('несуществующая сессия → isError', async () => {
      const res = await mockServer.callTool('session_update', { id: 99999, status: 'completed' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('повторное завершение (уже completed) → isError', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Завершённая', null, 'completed');
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('уже завершена');
      expect(text).toContain('completed');
    });

    it('уже abandoned → isError', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?)')
        .run('Заброшенная', null, 'abandoned');
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('уже завершена');
      expect(text).toContain('abandoned');
    });

    it('с задачами: pending и in_progress → переведены в failed', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'С задачами' });
      const sessionId = parseResponse(startRes).id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
        .run('Pending', 'executor_1', sessionId, 'pending', 'InProgress', 'executor_2', sessionId, 'in_progress');

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.cleanup.failed_tasks).toBe(2);

      const tasks = dbState.db.prepare('SELECT * FROM tasks WHERE session_id = ?').all(sessionId);
      expect(tasks.every((t) => t.status === 'failed' && t.result === 'Сессия завершена (completed)')).toBe(true);
    });

    it('с заблокированными файлами: файлы разблокированы', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'С блокировками' });
      const sessionId = parseResponse(startRes).id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id) VALUES (?, ?, ?)')
        .run('Задача с блокировкой', 'executor_1', sessionId);
      const taskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db
        .prepare('INSERT INTO file_locks (file, locked_by, task_id) VALUES (?, ?, ?)')
        .run('locked.js', 'executor_1', taskId);

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.cleanup.unlocked_files).toBe(1);

      const locks = dbState.db.prepare('SELECT * FROM file_locks').all();
      expect(locks.length).toBe(0);
    });

    it('без задач и файлов: cleanup = { unlocked_files: 0, failed_tasks: 0 }', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Пустая сессия' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.cleanup).toEqual({ unlocked_files: 0, failed_tasks: 0 });
    });

    it('задачи со статусом done НЕ затронуты', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'С done-задачами' });
      const sessionId = parseResponse(startRes).id;
      dbState.db
        .prepare('INSERT INTO tasks (title, assigned_to, session_id, status, result) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)')
        .run('Done1', 'executor_1', sessionId, 'done', 'OK', 'Done2', 'executor_2', sessionId, 'done', 'OK');

      const res = await mockServer.callTool('session_update', { id: sessionId, status: 'completed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.cleanup.failed_tasks).toBe(0);

      const doneTasks = dbState.db.prepare('SELECT * FROM tasks WHERE session_id = ? AND status = ?').all(sessionId, 'done');
      expect(doneTasks.length).toBe(2);
      expect(doneTasks.every((t) => t.result === 'OK')).toBe(true);
    });
  });

  describe('session_log', () => {
    it('основной сценарий — записывает событие', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Сессия для лога' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'task_created',
        content: 'Создана задача #1',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.session_id).toBe(sessionId);
      expect(data.event_type).toBe('task_created');
      expect(data.content).toBe('Создана задача #1');
      expect(data.created_at).toBeDefined();
    });

    it('несуществующий session_id → isError', async () => {
      const res = await mockServer.callTool('session_log', {
        session_id: 99999,
        event_type: 'note',
        content: 'Содержание',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('различные event_type корректно сохраняются', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Тест типов' });
      const sessionId = parseResponse(startRes).id;

      const types = ['task_started', 'task_completed', 'review_started', 'build_success', 'session_paused', 'note'];
      for (const eventType of types) {
        const res = await mockServer.callTool('session_log', {
          session_id: sessionId,
          event_type: eventType,
          content: `Событие ${eventType}`,
        });
        expect(res.isError).toBeUndefined();
        const data = parseResponse(res);
        expect(data.event_type).toBe(eventType);
      }

      const rows = dbState.db.prepare('SELECT event_type FROM session_log WHERE session_id = ? ORDER BY id').all(sessionId);
      expect(rows.map((r) => r.event_type)).toEqual(types);
    });

    it('content с пробелами — trim работает', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Тест trim' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'note',
        content: '  Текст с пробелами  ',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.content).toBe('Текст с пробелами');
    });

    it('несколько событий для одной сессии — все сохраняются', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Много событий' });
      const sessionId = parseResponse(startRes).id;

      await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'task_created',
        content: 'Событие 1',
      });
      await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'task_started',
        content: 'Событие 2',
      });
      const res3 = await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'task_completed',
        content: 'Событие 3',
      });

      const logs = dbState.db.prepare('SELECT * FROM session_log WHERE session_id = ? ORDER BY id').all(sessionId);
      expect(logs.length).toBe(3);
      expect(parseResponse(res3).session_id).toBe(sessionId);
    });

    it('session_id ссылается на существующую сессию (FK)', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal, plan) VALUES (?, ?)').run('Прямая вставка', null);
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'note',
        content: 'Событие для сессии из INSERT',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.session_id).toBe(sessionId);
    });

    it('content только из пробелов после trim → isError', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Тест пустого content' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'note',
        content: '   ',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустым');
    });
  });

  describe('session_history', () => {
    it('список всех сессий без фильтров', async () => {
      await mockServer.callTool('session_start', { goal: 'Сессия A' });
      await mockServer.callTool('session_start', { goal: 'Сессия B' });
      await mockServer.callTool('session_start', { goal: 'Сессия C' });

      const res = await mockServer.callTool('session_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.goal)).toContain('Сессия A');
      expect(rows.map((r) => r.goal)).toContain('Сессия B');
      expect(rows.map((r) => r.goal)).toContain('Сессия C');
    });

    it('фильтр по status', async () => {
      dbState.db
        .prepare('INSERT INTO sessions (goal, plan, status) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
        .run('Активная', null, 'active', 'Завершённая', null, 'completed', 'Заброшенная', null, 'abandoned');

      const res = await mockServer.callTool('session_history', { status: 'completed' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].goal).toBe('Завершённая');
    });

    it('конкретная сессия с логом', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Сессия с логом', plan: 'План' });
      const sessionId = parseResponse(startRes).id;
      await mockServer.callTool('session_log', {
        session_id: sessionId,
        event_type: 'task_created',
        content: 'Запись в лог',
      });

      const res = await mockServer.callTool('session_history', { session_id: sessionId });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBe(sessionId);
      expect(data.goal).toBe('Сессия с логом');
      expect(data.plan).toBe('План');
      expect(Array.isArray(data.logs)).toBe(true);
      expect(data.logs.length).toBe(1);
      expect(data.logs[0].event_type).toBe('task_created');
      expect(data.logs[0].content).toBe('Запись в лог');
    });

    it('конкретная сессия без логов — logs = пустой массив', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Сессия без логов' });
      const sessionId = parseResponse(startRes).id;

      const res = await mockServer.callTool('session_history', { session_id: sessionId });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBe(sessionId);
      expect(data.logs).toEqual([]);
    });

    it('несуществующий session_id → isError', async () => {
      const res = await mockServer.callTool('session_history', { session_id: 99999 });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('параметр limit работает', async () => {
      for (let i = 0; i < 5; i++) {
        await mockServer.callTool('session_start', { goal: `Сессия ${i + 1}` });
      }

      const res = await mockServer.callTool('session_history', { limit: 2 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('логи отсортированы по created_at ASC', async () => {
      const startRes = await mockServer.callTool('session_start', { goal: 'Порядок логов' });
      const sessionId = parseResponse(startRes).id;

      dbState.db
        .prepare(
          `INSERT INTO session_log (session_id, event_type, content, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
        )
        .run(
          sessionId, 'note', 'Первый', '2025-01-01 10:00:00',
          sessionId, 'note', 'Второй', '2025-01-01 11:00:00',
          sessionId, 'note', 'Третий', '2025-01-01 12:00:00'
        );

      const res = await mockServer.callTool('session_history', { session_id: sessionId });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.logs.length).toBe(3);
      expect(data.logs[0].content).toBe('Первый');
      expect(data.logs[1].content).toBe('Второй');
      expect(data.logs[2].content).toBe('Третий');
    });

    it('сессии отсортированы по created_at DESC', async () => {
      dbState.db
        .prepare(
          `INSERT INTO sessions (goal, plan, status, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
        )
        .run(
          'Старая', null, 'active', '2025-01-01 10:00:00',
          'Средняя', null, 'active', '2025-01-01 12:00:00',
          'Новая', null, 'active', '2025-01-01 14:00:00'
        );

      const res = await mockServer.callTool('session_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(3);
      expect(rows[0].goal).toBe('Новая');
      expect(rows[1].goal).toBe('Средняя');
      expect(rows[2].goal).toBe('Старая');
    });

    it('пустой результат — нет сессий → пустой массив', async () => {
      const res = await mockServer.callTool('session_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });

    it('limit=500 (максимум) — не вызывает ошибку', async () => {
      await mockServer.callTool('session_start', { goal: 'Тест лимита 500' });

      const res = await mockServer.callTool('session_history', { limit: 500 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
    });
  });
});
