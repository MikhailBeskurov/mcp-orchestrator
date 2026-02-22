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
import { register } from '../../tools/builds.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/builds', () => {
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

  describe('build_log', () => {
    it('основной сценарий — записывает успешную сборку, возвращает полный объект', async () => {
      const res = await mockServer.callTool('build_log', { success: true });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.success).toBe(true);
      expect(data.created_at).toBeDefined();
    });

    it('success=false — записывает неудачную сборку', async () => {
      const res = await mockServer.callTool('build_log', { success: false });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.success).toBe(false);
    });

    it('с session_id — привязка к сессии', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal, plan) VALUES (?, ?)').run('Цель', null);
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('build_log', { session_id: sessionId, success: true });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.session_id).toBe(sessionId);
    });

    it('без session_id — session_id = null', async () => {
      const res = await mockServer.callTool('build_log', { success: true });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.session_id).toBeNull();
    });

    it('с errors и warnings — массивы сохраняются и парсятся', async () => {
      const res = await mockServer.callTool('build_log', {
        success: true,
        errors: ['err1', 'err2'],
        warnings: ['warn1'],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.errors).toEqual(['err1', 'err2']);
      expect(data.warnings).toEqual(['warn1']);
    });

    it('с related_tasks — массив ID задач сохраняется', async () => {
      dbState.db.prepare('INSERT INTO tasks (title, assigned_to) VALUES (?, ?)').run('Задача', 'executor_1');
      const taskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('build_log', {
        success: true,
        related_tasks: [taskId],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.related_tasks).toEqual([taskId]);
    });

    it('без опциональных полей — errors/warnings/related_tasks = null', async () => {
      const res = await mockServer.callTool('build_log', { success: true });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.errors).toBeNull();
      expect(data.warnings).toBeNull();
      expect(data.related_tasks).toBeNull();
    });

    it('пустые массивы — сохраняются как пустые, не как null', async () => {
      const res = await mockServer.callTool('build_log', {
        success: true,
        errors: [],
        warnings: [],
        related_tasks: [],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.errors).toEqual([]);
      expect(data.warnings).toEqual([]);
      expect(data.related_tasks).toEqual([]);
    });

    it('несуществующий session_id → isError', async () => {
      const res = await mockServer.callTool('build_log', { session_id: 99999, success: true });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('несколько сборок подряд — автоинкремент ID', async () => {
      const res1 = await mockServer.callTool('build_log', { success: true });
      const res2 = await mockServer.callTool('build_log', { success: false });
      const res3 = await mockServer.callTool('build_log', { success: true });

      const data1 = parseResponse(res1);
      const data2 = parseResponse(res2);
      const data3 = parseResponse(res3);

      expect(data1.id).toBe(1);
      expect(data2.id).toBe(2);
      expect(data3.id).toBe(3);
    });

    it('success хранится в БД как INTEGER, в ответе — boolean', async () => {
      const res = await mockServer.callTool('build_log', { success: true });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);

      const row = dbState.db.prepare('SELECT success FROM builds WHERE id = ?').get(data.id);
      expect(row.success).toBe(1);
      expect(typeof row.success).toBe('number');

      expect(data.success).toBe(true);
      expect(typeof data.success).toBe('boolean');
    });

    it('все поля вместе — полный объект с распарсенными данными', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal, plan) VALUES (?, ?)').run('Цель', null);
      const sessionId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db.prepare('INSERT INTO tasks (title, assigned_to) VALUES (?, ?)').run('Задача', 'executor_1');
      const taskId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('build_log', {
        session_id: sessionId,
        success: false,
        errors: ['err1', 'err2'],
        warnings: ['warn1', 'warn2'],
        related_tasks: [taskId],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);

      expect(data.id).toBeDefined();
      expect(data.session_id).toBe(sessionId);
      expect(data.success).toBe(false);
      expect(data.errors).toEqual(['err1', 'err2']);
      expect(data.warnings).toEqual(['warn1', 'warn2']);
      expect(data.related_tasks).toEqual([taskId]);
      expect(data.created_at).toBeDefined();
    });
  });

  describe('build_history', () => {
    it('основной сценарий — список всех сборок', async () => {
      await mockServer.callTool('build_log', { success: true });
      await mockServer.callTool('build_log', { success: false });
      await mockServer.callTool('build_log', { success: true });

      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it('фильтр по session_id — только сборки этой сессии', async () => {
      dbState.db.prepare('INSERT INTO sessions (goal, plan) VALUES (?, ?)').run('Сессия 1', null);
      const session1Id = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;
      dbState.db.prepare('INSERT INTO sessions (goal, plan) VALUES (?, ?)').run('Сессия 2', null);
      const session2Id = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      await mockServer.callTool('build_log', { session_id: session1Id, success: true });
      await mockServer.callTool('build_log', { session_id: session2Id, success: false });

      const res = await mockServer.callTool('build_history', { session_id: session1Id });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].session_id).toBe(session1Id);
      expect(rows[0].success).toBe(true);
    });

    it('пустой результат — пустой массив', async () => {
      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });

    it('параметр limit работает', async () => {
      for (let i = 0; i < 5; i++) {
        await mockServer.callTool('build_log', { success: true });
      }

      const res = await mockServer.callTool('build_history', { limit: 2 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('сортировка по created_at DESC', async () => {
      dbState.db
        .prepare(
          `INSERT INTO builds (session_id, success, created_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`
        )
        .run(
          null, 1, '2025-01-01 10:00:00',
          null, 0, '2025-01-01 12:00:00',
          null, 1, '2025-01-01 14:00:00'
        );

      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(3);
      expect(rows[0].created_at).toBe('2025-01-01 14:00:00');
      expect(rows[1].created_at).toBe('2025-01-01 12:00:00');
      expect(rows[2].created_at).toBe('2025-01-01 10:00:00');
    });

    it('несуществующий session_id → isError', async () => {
      const res = await mockServer.callTool('build_history', { session_id: 99999 });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('JSON-поля распарсены в ответе', async () => {
      await mockServer.callTool('build_log', {
        success: false,
        errors: ['err1'],
        warnings: ['warn1'],
        related_tasks: [1, 2],
      });

      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].errors).toEqual(['err1']);
      expect(rows[0].warnings).toEqual(['warn1']);
      expect(rows[0].related_tasks).toEqual([1, 2]);
    });

    it('success в ответе — boolean', async () => {
      await mockServer.callTool('build_log', { success: true });
      await mockServer.callTool('build_log', { success: false });

      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
      expect(typeof rows[0].success).toBe('boolean');
      expect(typeof rows[1].success).toBe('boolean');
      expect(rows.some((r) => r.success === true)).toBe(true);
      expect(rows.some((r) => r.success === false)).toBe(true);
    });

    it('limit=500 (максимум) — не вызывает ошибку', async () => {
      await mockServer.callTool('build_log', { success: true });

      const res = await mockServer.callTool('build_history', { limit: 500 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
    });

    it('дефолтный limit — не более DEFAULT_HISTORY_LIMIT записей', async () => {
      for (let i = 0; i < 55; i++) {
        dbState.db.prepare('INSERT INTO builds (success) VALUES (?)').run(1);
      }
      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(50);
    });

    it('без фильтров — все сборки', async () => {
      await mockServer.callTool('build_log', { success: true });
      await mockServer.callTool('build_log', { success: false });
      await mockServer.callTool('build_log', { success: true });

      const res = await mockServer.callTool('build_history', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(3);
    });
  });
});
