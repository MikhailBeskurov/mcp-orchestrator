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
import { register } from '../../tools/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function setupDb() {
  dbState.db = new Database(':memory:');
  dbState.db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../../schema.sql'), 'utf-8');
  dbState.db.exec(schema);
}

describe('tools/config', () => {
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

  describe('config_get', () => {
    it('основной сценарий — возвращает значение по ключу (дефолтный max_review_iterations)', async () => {
      const res = await mockServer.callTool('config_get', { key: 'max_review_iterations' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toHaveProperty('key', 'max_review_iterations');
      expect(data).toHaveProperty('value', '3');
    });

    it('все настройки — без key возвращает массив (минимум 3 дефолтных)', async () => {
      const res = await mockServer.callTool('config_get', {});
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(3);
      expect(data.some((r) => r.key === 'max_review_iterations')).toBe(true);
      expect(data.some((r) => r.key === 'auto_lock_files')).toBe(true);
      expect(data.some((r) => r.key === 'review_priorities_enforce')).toBe(true);
    });

    it('несуществующий ключ → isError', async () => {
      const res = await mockServer.callTool('config_get', { key: 'nonexistent_key_xyz' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('не найдена');
      expect(text).toContain('nonexistent_key_xyz');
    });

    it('пустой ключ (только пробелы) → isError', async () => {
      const res = await mockServer.callTool('config_get', { key: '   ' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('пустым');
    });

    it('формат ответа {key, value} при запросе по ключу', async () => {
      const res = await mockServer.callTool('config_get', { key: 'auto_lock_files' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual({ key: 'auto_lock_files', value: 'true' });
    });

    it('дефолтные значения доступны через config_get', async () => {
      const res = await mockServer.callTool('config_get', {});
      expect(res.isError).toBeUndefined();
      const rows = parseResponse(res);
      const maxIter = rows.find((r) => r.key === 'max_review_iterations');
      const autoLock = rows.find((r) => r.key === 'auto_lock_files');
      const priorities = rows.find((r) => r.key === 'review_priorities_enforce');
      expect(maxIter?.value).toBe('3');
      expect(autoLock?.value).toBe('true');
      expect(priorities?.value).toBe('true');
    });

    it('key=null — возвращает все настройки', async () => {
      const res = await mockServer.callTool('config_get', { key: null });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(3);
    });

    it('пустая таблица config — возвращает пустой массив', async () => {
      dbState.db.prepare('DELETE FROM config').run();
      const res = await mockServer.callTool('config_get', {});
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual([]);
    });
  });

  describe('config_set', () => {
    it('основной сценарий — создание новой настройки, возвращает {key, value}', async () => {
      const res = await mockServer.callTool('config_set', {
        key: 'custom_setting',
        value: 'custom_value',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual({ key: 'custom_setting', value: 'custom_value' });
    });

    it('перезапись существующей настройки', async () => {
      const res1 = await mockServer.callTool('config_set', {
        key: 'max_review_iterations',
        value: '5',
      });
      expect(res1.isError).toBeUndefined();
      const data1 = parseResponse(res1);
      expect(data1.value).toBe('5');

      const res2 = await mockServer.callTool('config_get', { key: 'max_review_iterations' });
      expect(res2.isError).toBeUndefined();
      const data2 = parseResponse(res2);
      expect(data2.value).toBe('5');
    });

    it('пустой key → isError', async () => {
      const res = await mockServer.callTool('config_set', { key: '', value: 'v' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Ключ');
      expect(text).toContain('пустым');
    });

    it('пустой value → isError', async () => {
      const res = await mockServer.callTool('config_set', { key: 'k', value: '' });
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('Значение');
      expect(text).toContain('пустым');
    });

    it('key с пробелами — trim работает', async () => {
      const res = await mockServer.callTool('config_set', {
        key: '  trimmed_key  ',
        value: 'v',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.key).toBe('trimmed_key');

      const getRes = await mockServer.callTool('config_get', { key: 'trimmed_key' });
      expect(getRes.isError).toBeUndefined();
      expect(parseResponse(getRes).value).toBe('v');
    });

    it('value с пробелами — trim работает', async () => {
      const res = await mockServer.callTool('config_set', {
        key: 'k',
        value: '  trimmed_value  ',
      });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data.value).toBe('trimmed_value');
    });

    it('идемпотентность: повторный set того же значения не ломает', async () => {
      await mockServer.callTool('config_set', { key: 'idem_key', value: 'idem_val' });
      const res2 = await mockServer.callTool('config_set', { key: 'idem_key', value: 'idem_val' });
      expect(res2.isError).toBeUndefined();
      const data = parseResponse(res2);
      expect(data).toEqual({ key: 'idem_key', value: 'idem_val' });

      const getRes = await mockServer.callTool('config_get', { key: 'idem_key' });
      expect(getRes.isError).toBeUndefined();
      expect(parseResponse(getRes).value).toBe('idem_val');
    });
  });

  describe('интеграция config_set + config_get', () => {
    it('set → get → совпадает', async () => {
      await mockServer.callTool('config_set', { key: 'integration_test', value: 'test_value' });
      const res = await mockServer.callTool('config_get', { key: 'integration_test' });
      expect(res.isError).toBeUndefined();
      const data = parseResponse(res);
      expect(data).toEqual({ key: 'integration_test', value: 'test_value' });
    });
  });
});
