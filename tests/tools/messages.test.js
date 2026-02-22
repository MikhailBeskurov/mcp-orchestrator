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
import { register } from '../../tools/messages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

function createTask(title = 'Тестовая задача') {
  dbState.db.prepare('INSERT INTO tasks (title, assigned_to) VALUES (?, ?)').run(title, 'executor_1');
  return dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
}

describe('tools/messages', () => {
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

  describe('message_send', () => {
    it('основной сценарий — отправка сообщения', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Привет',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.from_agent).toBe('executor_1');
      expect(data.to_agent).toBe('orchestrator');
      expect(data.type).toBe('info');
      expect(data.content).toBe('Привет');
      expect(data.read).toBe(0);
      expect(data.created_at).toBeDefined();
    });

    it('с task_id — привязка к задаче', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        task_id: taskId,
        content: 'Сообщение по задаче',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.task_id).toBe(taskId);
    });

    it('все типы сообщений корректно сохраняются', async () => {
      const types = ['info', 'question', 'blocker', 'done'];
      for (const type of types) {
        const res = await mockServer.callTool('message_send', {
          from_agent: 'executor_1',
          to_agent: 'orchestrator',
          type,
          content: `Сообщение типа ${type}`,
        });
        expect(res.isError).toBeUndefined();
        const data = parseResponse(res);
        expect(data.type).toBe(type);
      }
    });

    it('content с пробелами — trim работает', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: '  Текст с пробелами  ',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.content).toBe('Текст с пробелами');
    });

    it('пустой content после trim → isError', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: '   ',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустым');
    });

    it('несуществующий task_id → isError', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        task_id: 99999,
        content: 'Сообщение',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('read по умолчанию = 0', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Проверка read',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      const row = dbState.db.prepare('SELECT read FROM messages WHERE id = ?').get(data.id);
      expect(row.read).toBe(0);
    });

    it('type по умолчанию = info', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Без указания type',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.type).toBe('info');
    });

    it('несколько сообщений подряд — автоинкремент ID', async () => {
      const res1 = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Первое',
      });
      const res2 = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Второе',
      });
      const res3 = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Третье',
      });
      const data1 = parseResponse(res1);
      const data2 = parseResponse(res2);
      const data3 = parseResponse(res3);
      expect(data1.id).toBe(1);
      expect(data2.id).toBe(2);
      expect(data3.id).toBe(3);
    });

    it('from_agent = to_agent — допустимо', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'executor_1',
        content: 'Сам себе',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.from_agent).toBe('executor_1');
      expect(data.to_agent).toBe('executor_1');
    });

    it('task_id = null (не передан) — сохраняется как null', async () => {
      const res = await mockServer.callTool('message_send', {
        from_agent: 'executor_1',
        to_agent: 'orchestrator',
        content: 'Без task_id',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      const row = dbState.db.prepare('SELECT task_id FROM messages WHERE id = ?').get(data.id);
      expect(row.task_id).toBeNull();
    });
  });

  describe('message_read', () => {
    it('основной сценарий — чтение непрочитанных для роли', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Сообщение 1',
      });
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Сообщение 2',
      });
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('после чтения — сообщения помечены как read=1', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Непрочитанное',
      });
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);
      const row = dbState.db.prepare('SELECT read FROM messages WHERE id = ?').get(data[0].id);
      expect(row.read).toBe(1);
    });

    it('unread_only=false — возвращает все (и прочитанные тоже)', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Сообщение',
      });
      await mockServer.callTool('message_read', { role: 'executor_1' });
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        unread_only: false,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);
    });

    it('фильтр по task_id', async () => {
      const taskId1 = createTask('Задача 1');
      const taskId2 = createTask('Задача 2');
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        task_id: taskId1,
        content: 'Для задачи 1',
      });
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        task_id: taskId2,
        content: 'Для задачи 2',
      });
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        task_id: taskId1,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);
      expect(data[0].task_id).toBe(taskId1);
      expect(data[0].content).toBe('Для задачи 1');
    });

    it('пустой результат — нет сообщений → пустой массив', async () => {
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual([]);
    });

    it('limit работает', async () => {
      for (let i = 0; i < 5; i++) {
        await mockServer.callTool('message_send', {
          from_agent: 'orchestrator',
          to_agent: 'executor_1',
          content: `Сообщение ${i + 1}`,
        });
      }
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        limit: 2,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(2);
    });

    it('сообщения отсортированы по created_at ASC', async () => {
      dbState.db
        .prepare(
          `INSERT INTO messages (from_agent, to_agent, content, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
        )
        .run(
          'orchestrator',
          'executor_1',
          'Третий',
          '2025-01-01 12:00:00',
          'orchestrator',
          'executor_1',
          'Первый',
          '2025-01-01 10:00:00',
          'orchestrator',
          'executor_1',
          'Второй',
          '2025-01-01 11:00:00'
        );
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(3);
      expect(data[0].content).toBe('Первый');
      expect(data[1].content).toBe('Второй');
      expect(data[2].content).toBe('Третий');
    });

    it('чтение не затрагивает сообщения другой роли', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Для executor_1',
      });
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_2',
        content: 'Для executor_2',
      });
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);
      expect(data[0].content).toBe('Для executor_1');
      const row2 = dbState.db
        .prepare('SELECT read FROM messages WHERE to_agent = ?')
        .get('executor_2');
      expect(row2).toBeDefined();
      expect(row2.read).toBe(0);
    });

    it('повторное чтение unread_only=true → пустой массив', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Единственное',
      });
      await mockServer.callTool('message_read', { role: 'executor_1' });
      const res = await mockServer.callTool('message_read', { role: 'executor_1' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual([]);
    });

    it('комбинация фильтров: role + task_id + unread_only=false', async () => {
      const taskId1 = createTask('Задача A');
      const taskId2 = createTask('Задача B');
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        task_id: taskId1,
        content: 'Сообщение A1',
      });
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        task_id: taskId1,
        content: 'Сообщение A2',
      });
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        task_id: taskId2,
        content: 'Сообщение B',
      });
      await mockServer.callTool('message_read', { role: 'executor_1' });
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        task_id: taskId1,
        unread_only: false,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(2);
      expect(data.every((m) => m.task_id === taskId1)).toBe(true);
    });

    it('limit=500 (максимум) — не вызывает ошибку', async () => {
      await mockServer.callTool('message_send', {
        from_agent: 'orchestrator',
        to_agent: 'executor_1',
        content: 'Тест лимита',
      });
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        limit: 500,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);
    });

    it('task_id без сообщений для роли → пустой массив', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        task_id: taskId,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual([]);
    });

    it('несуществующий task_id → пустой массив', async () => {
      const res = await mockServer.callTool('message_read', {
        role: 'executor_1',
        task_id: 99999,
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual([]);
    });
  });
});
