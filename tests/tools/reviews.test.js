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
import { register } from '../../tools/reviews.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/reviews', () => {
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

  describe('review_submit', () => {
    it('основной сценарий — создаёт замечание', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        description: 'Текст замечания',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.task_id).toBe(taskId);
      expect(data.status).toBe('open');
    });

    it('ошибка: task_id не найден → isError', async () => {
      const res = await mockServer.callTool('review_submit', {
        task_id: 99999,
        reviewer: 'reviewer_impl',
        description: 'Текст',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('ошибка: line_start без file → isError', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        description: 'Текст',
        line_start: 10,
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('file');
    });

    it('ошибка: line_end без file → isError', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        description: 'Текст',
        line_end: 10,
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('file');
    });

    it('ошибка: line_end < line_start → isError', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        description: 'Текст',
        file: 'a.js',
        line_start: 20,
        line_end: 10,
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('line_end');
    });

    it('с file и диапазоном строк', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_arch',
        file: 'src/main.js',
        line_start: 5,
        line_end: 10,
        description: 'Замечание по коду',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBeGreaterThan(0);

      const row = dbState.db.prepare('SELECT * FROM reviews WHERE id = ?').get(data.id);
      expect(row.file).toBe('src/main.js');
      expect(row.line_start).toBe(5);
      expect(row.line_end).toBe(10);
    });

    it('все опциональные поля', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        file: 'x.js',
        line_start: 1,
        line_end: 2,
        priority: 'high',
        category: 'bug',
        description: 'Баг',
        suggestion: 'Исправить так',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBeGreaterThan(0);

      const row = dbState.db.prepare('SELECT * FROM reviews WHERE id = ?').get(data.id);
      expect(row.priority).toBe('high');
      expect(row.category).toBe('bug');
      expect(row.suggestion).toBe('Исправить так');
    });

    it('review_submit возвращает полный объект (п. 10.3)', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        file: 'a.js',
        line_start: 1,
        line_end: 2,
        priority: 'high',
        category: 'bug',
        description: 'Замечание',
        suggestion: 'Исправить',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      const requiredFields = [
        'id',
        'task_id',
        'reviewer',
        'file',
        'line_start',
        'line_end',
        'priority',
        'category',
        'description',
        'suggestion',
        'status',
        'resolve_comment',
        'created_at',
      ];
      for (const field of requiredFields) {
        expect(data).toHaveProperty(field);
      }
      expect(data.task_id).toBe(taskId);
      expect(data.reviewer).toBe('reviewer_impl');
      expect(data.file).toBe('a.js');
      expect(data.status).toBe('open');
    });

    it('пустой file (пробелы) нормализуется в null', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit', {
        task_id: taskId,
        reviewer: 'reviewer_impl',
        file: '   ',
        description: 'Текст',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      const row = dbState.db.prepare('SELECT file FROM reviews WHERE id = ?').get(data.id);
      expect(row.file).toBeNull();
    });
  });

  describe('review_list', () => {
    it('все замечания без фильтров', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_arch', 'B')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('фильтр по task_id', async () => {
      const t1 = createTask();
      const t2 = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_impl', 'B')`
        )
        .run(t1, t2);

      const res = await mockServer.callTool('review_list', { task_id: t1 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].task_id).toBe(t1);
    });

    it('фильтр по priority', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, priority) VALUES (?, 'reviewer_impl', 'A', 'normal'), (?, 'reviewer_impl', 'B', 'critical')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { priority: 'critical' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].priority).toBe('critical');
    });

    it('фильтр по status', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, status) VALUES (?, 'reviewer_impl', 'A', 'open'), (?, 'reviewer_impl', 'B', 'fixed')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { status: 'fixed' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('fixed');
    });

    it('фильтр по reviewer', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_arch', 'B')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { reviewer: 'reviewer_arch' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].reviewer).toBe('reviewer_arch');
    });

    it('фильтр по category', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, category) VALUES (?, 'reviewer_impl', 'A', 'bug'), (?, 'reviewer_impl', 'B', 'style')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { category: 'style' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].category).toBe('style');
    });

    it('фильтр по file', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, file) VALUES (?, 'reviewer_impl', 'A', 'a.js'), (?, 'reviewer_impl', 'B', 'b.js')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { file: 'b.js' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].file).toBe('b.js');
    });

    it('параметр limit', async () => {
      const taskId = createTask();
      for (let i = 0; i < 5; i++) {
        dbState.db
          .prepare(
            `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', ?)`
          )
          .run(taskId, `R${i}`);
      }

      const res = await mockServer.callTool('review_list', { limit: 2 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('limit: 1 — возвращает ровно 1 запись', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_impl', 'B')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { limit: 1 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
    });

    it('file из пробелов — фильтр не применяется, возвращает все замечания', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, file) VALUES (?, 'reviewer_impl', 'A', 'a.js'), (?, 'reviewer_impl', 'B', 'b.js')`
        )
        .run(taskId, taskId);

      const res = await mockServer.callTool('review_list', { file: '   ' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('пустой результат', async () => {
      const res = await mockServer.callTool('review_list', { task_id: 99999 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });
  });

  describe('review_resolve', () => {
    it('resolve как fixed', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'Замечание')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve', { id: reviewId, status: 'fixed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.status).toBe('fixed');
    });

    it('resolve как wontfix с комментарием', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'Замечание')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve', {
        id: reviewId,
        status: 'wontfix',
        resolve_comment: 'По согласованию',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.status).toBe('wontfix');
      expect(data.resolve_comment).toBe('По согласованию');
    });

    it('ошибка: замечание не найдено → isError', async () => {
      const res = await mockServer.callTool('review_resolve', {
        id: 99999,
        status: 'fixed',
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдено');
    });

    it('ошибка: уже закрытое замечание → isError', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, status) VALUES (?, 'reviewer_impl', 'Замечание', 'fixed')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve', { id: reviewId, status: 'wontfix' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('уже закрыто');
    });

    it('без resolve_comment — resolve_comment остаётся null', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'Замечание')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve', { id: reviewId, status: 'fixed' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.resolve_comment).toBeNull();
    });
  });

  describe('review_submit_batch', () => {
    it('основной сценарий — батч из 2 замечаний', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          { task_id: taskId, reviewer: 'reviewer_impl', description: 'Замечание 1' },
          { task_id: taskId, reviewer: 'reviewer_arch', description: 'Замечание 2' },
        ],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
      expect(data[0].task_id).toBe(taskId);
      expect(data[0].description).toBe('Замечание 1');
      expect(data[1].description).toBe('Замечание 2');
    });

    it('ошибка: task_id не найден в элементе → isError, ничего не записано', async () => {
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          {
            task_id: 99999,
            reviewer: 'reviewer_impl',
            description: 'Текст',
          },
        ],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [0]');
      expect(text).toContain('не найдена');

      const count = dbState.db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
      expect(count).toBe(0);
    });

    it('ошибка: line_end без file → isError с индексом элемента', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          {
            task_id: taskId,
            reviewer: 'reviewer_impl',
            description: 'Текст',
            line_end: 10,
          },
        ],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [0]');
      expect(text).toContain('file');

      const count = dbState.db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
      expect(count).toBe(0);
    });

    it('ошибка: line_end < line_start → isError с индексом элемента', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          {
            task_id: taskId,
            reviewer: 'reviewer_impl',
            description: 'Текст',
            file: 'a.js',
            line_start: 20,
            line_end: 10,
          },
        ],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [0]');
      expect(text).toContain('line_end');

      const count = dbState.db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
      expect(count).toBe(0);
    });

    it('атомарность: ошибка во 2-м элементе → 1-й тоже не записан', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          { task_id: taskId, reviewer: 'reviewer_impl', description: 'Валидное' },
          { task_id: 99999, reviewer: 'reviewer_impl', description: 'Невалидная задача' },
        ],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [1]');

      const count = dbState.db.prepare('SELECT COUNT(*) as c FROM reviews').get().c;
      expect(count).toBe(0);
    });

    it('все опциональные поля', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          {
            task_id: taskId,
            reviewer: 'reviewer_impl',
            file: 'x.js',
            line_start: 1,
            line_end: 2,
            priority: 'high',
            category: 'bug',
            description: 'Баг',
            suggestion: 'Исправить так',
          },
        ],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);

      const row = dbState.db.prepare('SELECT * FROM reviews WHERE id = ?').get(data[0].id);
      expect(row.file).toBe('x.js');
      expect(row.line_start).toBe(1);
      expect(row.line_end).toBe(2);
      expect(row.priority).toBe('high');
      expect(row.category).toBe('bug');
      expect(row.suggestion).toBe('Исправить так');
    });

    it('возвращает полные объекты', async () => {
      const taskId = createTask();
      const res = await mockServer.callTool('review_submit_batch', {
        reviews: [
          {
            task_id: taskId,
            reviewer: 'reviewer_impl',
            file: 'a.js',
            line_start: 1,
            line_end: 2,
            priority: 'high',
            category: 'bug',
            description: 'Замечание',
            suggestion: 'Исправить',
          },
        ],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.length).toBe(1);

      const requiredFields = [
        'id',
        'task_id',
        'reviewer',
        'file',
        'line_start',
        'line_end',
        'priority',
        'category',
        'description',
        'suggestion',
        'status',
        'resolve_comment',
        'created_at',
      ];
      for (const field of requiredFields) {
        expect(data[0]).toHaveProperty(field);
      }
      expect(data[0].task_id).toBe(taskId);
      expect(data[0].reviewer).toBe('reviewer_impl');
      expect(data[0].file).toBe('a.js');
      expect(data[0].status).toBe('open');
    });
  });

  describe('review_resolve_batch', () => {
    it('основной сценарий — батч-закрытие 2 замечаний', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_impl', 'B')`
        )
        .run(taskId, taskId);
      const ids = dbState.db
        .prepare('SELECT id FROM reviews ORDER BY id')
        .all()
        .map((r) => r.id);

      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [
          { id: ids[0], status: 'fixed' },
          { id: ids[1], status: 'wontfix' },
        ],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
      expect(data[0].status).toBe('fixed');
      expect(data[1].status).toBe('wontfix');
    });

    it('ошибка: замечание не найдено → isError', async () => {
      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [{ id: 99999, status: 'fixed' }],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [0]');
      expect(text).toContain('не найдено');
    });

    it('ошибка: уже закрытое замечание → isError с индексом', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description, status) VALUES (?, 'reviewer_impl', 'Замечание', 'fixed')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [{ id: reviewId, status: 'wontfix' }],
      });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Элемент [0]');
      expect(text).toContain('уже закрыто');
    });

    it('атомарность: ошибка во 2-м → 1-й тоже не обновлён', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'A'), (?, 'reviewer_impl', 'B')`
        )
        .run(taskId, taskId);
      const ids = dbState.db
        .prepare('SELECT id FROM reviews ORDER BY id')
        .all()
        .map((r) => r.id);

      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [
          { id: ids[0], status: 'fixed' },
          { id: 99999, status: 'fixed' },
        ],
      });
      expect(res.isError).toBe(true);

      const row1 = dbState.db.prepare('SELECT status FROM reviews WHERE id = ?').get(ids[0]);
      expect(row1.status).toBe('open');
    });

    it('с resolve_comment', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'Замечание')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [
          {
            id: reviewId,
            status: 'wontfix',
            resolve_comment: 'По согласованию',
          },
        ],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data[0].status).toBe('wontfix');
      expect(data[0].resolve_comment).toBe('По согласованию');
    });

    it('без resolve_comment — resolve_comment остаётся null', async () => {
      const taskId = createTask();
      dbState.db
        .prepare(
          `INSERT INTO reviews (task_id, reviewer, description) VALUES (?, 'reviewer_impl', 'Замечание')`
        )
        .run(taskId);
      const reviewId = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('review_resolve_batch', {
        resolutions: [{ id: reviewId, status: 'fixed' }],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data[0].resolve_comment).toBeNull();
    });
  });
});
