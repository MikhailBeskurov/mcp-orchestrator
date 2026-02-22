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
import { register } from '../../tools/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/memory', () => {
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

  describe('memory_store', () => {
    it('основной сценарий — создаёт запись с обязательными полями', async () => {
      const res = await mockServer.callTool('memory_store', {
        category: 'decision',
        title: 'Использовать SQLite',
        content: 'Выбрали SQLite для локального хранения',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('id');
      expect(data.category).toBe('decision');
      expect(data.title).toBe('Использовать SQLite');
      expect(data.created_at).toBeDefined();
    });

    it('все опциональные поля — tags и related_files', async () => {
      const res = await mockServer.callTool('memory_store', {
        category: 'pattern',
        title: 'Паттерн репозитория',
        content: 'Описание паттерна',
        tags: ['repository', 'ddd'],
        related_files: ['src/repo.js', 'src/models.js'],
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);

      const row = dbState.db.prepare('SELECT tags, related_files FROM memory WHERE id = ?').get(data.id);
      expect(row.tags).toBe(JSON.stringify(['repository', 'ddd']));
      expect(row.related_files).toBe(JSON.stringify(['src/repo.js', 'src/models.js']));
    });

    it('без tags и related_files — сохраняются как null', async () => {
      const res = await mockServer.callTool('memory_store', {
        category: 'convention',
        title: 'Конвенция именования',
        content: 'Используем camelCase',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);

      const row = dbState.db.prepare('SELECT tags, related_files FROM memory WHERE id = ?').get(data.id);
      expect(row.tags).toBeNull();
      expect(row.related_files).toBeNull();
    });

    it('различные категории корректно сохраняются', async () => {
      const categories = ['architecture', 'bug', 'gotcha'];
      for (const cat of categories) {
        const res = await mockServer.callTool('memory_store', {
          category: cat,
          title: `Запись ${cat}`,
          content: 'Содержание',
        });
        expect(res.isError).toBeUndefined();
        const data = parseResponse(res);
        expect(data.category).toBe(cat);
      }

      const rows = dbState.db.prepare('SELECT category FROM memory ORDER BY id').all();
      expect(rows.map((r) => r.category)).toEqual(['architecture', 'bug', 'gotcha']);
    });
  });

  describe('memory_search', () => {
    it('все записи без фильтров', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'A', 'Content A', 'pattern', 'B', 'Content B', 'bug', 'C', 'Content C');

      const res = await mockServer.callTool('memory_search', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it('пустой query — не добавляет фильтр по тексту', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'Запись1', 'Content1', 'pattern', 'Запись2', 'Content2');

      const res = await mockServer.callTool('memory_search', { query: '' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('фильтр по category', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'D1', 'C1', 'pattern', 'P1', 'C2', 'decision', 'D2', 'C3');

      const res = await mockServer.callTool('memory_search', { category: 'pattern' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].category).toBe('pattern');
      expect(rows[0].title).toBe('P1');
    });

    it('поиск по query в title', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'УникальныйЗаголовок', 'Content', 'pattern', 'Другой', 'Content');

      const res = await mockServer.callTool('memory_search', { query: 'Уникальный' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe('УникальныйЗаголовок');
    });

    it('поиск по query в content', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'A', 'СекретноеСлово в тексте', 'pattern', 'B', 'Обычный текст');

      const res = await mockServer.callTool('memory_search', { query: 'СекретноеСлово' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].content).toContain('СекретноеСлово');
    });

    it('поиск по query в tags', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content, tags) VALUES (?, ?, ?, ?), (?, ?, ?, ?)'
        )
        .run('decision', 'A', 'C', '["тегАльфа","бета"]', 'pattern', 'B', 'C', '["гамма"]');

      const res = await mockServer.callTool('memory_search', { query: 'тегАльфа' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe('A');
    });

    it('комбинация query + category', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'Ключ', 'Content', 'pattern', 'Ключ', 'Content', 'decision', 'Другой', 'Content');

      const res = await mockServer.callTool('memory_search', { query: 'Ключ', category: 'pattern' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].category).toBe('pattern');
      expect(rows[0].title).toBe('Ключ');
    });

    it('параметр limit', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)'
        )
        .run(
          'decision', '1', 'C',
          'decision', '2', 'C',
          'decision', '3', 'C',
          'decision', '4', 'C',
          'decision', '5', 'C'
        );

      const res = await mockServer.callTool('memory_search', { limit: 2 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(2);
    });

    it('пустой результат — нет совпадений', async () => {
      dbState.db
        .prepare('INSERT INTO memory (category, title, content) VALUES (?, ?, ?)')
        .run('decision', 'Существующее', 'Content');

      const res = await mockServer.callTool('memory_search', { query: 'НесуществующаяСтрока12345' });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows).toEqual([]);
    });

    it('tags и related_files распарсены в массивы', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content, tags, related_files) VALUES (?, ?, ?, ?, ?)'
        )
        .run('decision', 'T', 'C', '["a","b"]', '["f1.js","f2.js"]');

      const res = await mockServer.callTool('memory_search', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(Array.isArray(rows[0].tags)).toBe(true);
      expect(rows[0].tags).toEqual(['a', 'b']);
      expect(Array.isArray(rows[0].related_files)).toBe(true);
      expect(rows[0].related_files).toEqual(['f1.js', 'f2.js']);
    });

    it('невалидный JSON в tags — парсится как null', async () => {
      dbState.db
        .prepare('INSERT INTO memory (category, title, content, tags) VALUES (?, ?, ?, ?)')
        .run('decision', 'Тест', 'Content', '{invalid}');

      const res = await mockServer.callTool('memory_search', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
      expect(rows[0].tags).toBe(null);
    });

    it('limit: 1 — возвращает ровно 1 запись', async () => {
      dbState.db
        .prepare(
          'INSERT INTO memory (category, title, content) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)'
        )
        .run('decision', 'A', 'C1', 'pattern', 'B', 'C2', 'bug', 'C', 'C3');

      const res = await mockServer.callTool('memory_search', { limit: 1 });
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      expect(rows.length).toBe(1);
    });
  });

  describe('memory_delete', () => {
    it('основной сценарий — удаляет запись', async () => {
      dbState.db.prepare('INSERT INTO memory (category, title, content) VALUES (?, ?, ?)').run('decision', 'Удаляемая', 'Content');
      const id = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res = await mockServer.callTool('memory_delete', { id });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.id).toBe(id);
      expect(data.deleted).toBe(true);
    });

    it('запись не найдена → isError', async () => {
      const res = await mockServer.callTool('memory_delete', { id: 99999 });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });

    it('после удаления запись отсутствует в БД', async () => {
      dbState.db.prepare('INSERT INTO memory (category, title, content) VALUES (?, ?, ?)').run('decision', 'Удаляемая', 'Content');
      const id = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      await mockServer.callTool('memory_delete', { id });

      const row = dbState.db.prepare('SELECT id FROM memory WHERE id = ?').get(id);
      expect(row).toBeUndefined();
    });

    it('идемпотентность — повторное удаление → isError', async () => {
      dbState.db.prepare('INSERT INTO memory (category, title, content) VALUES (?, ?, ?)').run('decision', 'Удаляемая', 'Content');
      const id = dbState.db.prepare('SELECT last_insert_rowid() as id').get().id;

      const res1 = await mockServer.callTool('memory_delete', { id });
      expect(res1.isError).toBeUndefined();

      const res2 = await mockServer.callTool('memory_delete', { id });
      expect(res2.isError).toBe(true);
      const text = res2.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
    });
  });
});
