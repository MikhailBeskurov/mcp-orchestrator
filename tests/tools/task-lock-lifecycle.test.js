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

function createSession(goal) {
  const result = dbState.db.prepare('INSERT INTO sessions (goal) VALUES (?)').run(goal);
  return Number(result.lastInsertRowid);
}

describe('task file-lock lifecycle', () => {
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

  it('передаёт общую блокировку следующей активной задаче того же агента и сессии', async () => {
    const sessionId = createSession('Общая сессия');

    const firstResponse = await mockServer.callTool('task_create', {
      title: 'Первая задача',
      assigned_to: 'executor_1',
      status: 'in_progress',
      files: ['src/shared.js'],
      session_id: sessionId,
    });
    const firstTask = parseResponse(firstResponse);

    const secondResponse = await mockServer.callTool('task_create', {
      title: 'Вторая задача',
      assigned_to: 'executor_1',
      status: 'in_progress',
      files: ['src/shared.js'],
      session_id: sessionId,
    });
    const secondTask = parseResponse(secondResponse);

    const initialLock = dbState.db
      .prepare('SELECT task_id FROM file_locks WHERE file = ?')
      .get('src/shared.js');
    expect(initialLock.task_id).toBe(firstTask.id);

    const firstDoneResponse = await mockServer.callTool('task_update', {
      id: firstTask.id,
      status: 'done',
    });
    const firstDone = parseResponse(firstDoneResponse);
    expect(firstDone.unlocked_files).toBe(0);
    expect(firstDone.transferred_files).toBe(1);

    const transferredLock = dbState.db
      .prepare('SELECT task_id FROM file_locks WHERE file = ?')
      .get('src/shared.js');
    expect(transferredLock.task_id).toBe(secondTask.id);

    const secondDoneResponse = await mockServer.callTool('task_update', {
      id: secondTask.id,
      status: 'done',
    });
    const secondDone = parseResponse(secondDoneResponse);
    expect(secondDone.unlocked_files).toBe(1);
    expect(secondDone.transferred_files).toBe(0);

    const finalLock = dbState.db
      .prepare('SELECT task_id FROM file_locks WHERE file = ?')
      .get('src/shared.js');
    expect(finalLock).toBeUndefined();
  });

  it('отклоняет общую активную блокировку между разными сессиями без частичной записи', async () => {
    const firstSessionId = createSession('Первая сессия');
    const secondSessionId = createSession('Вторая сессия');

    const firstResponse = await mockServer.callTool('task_create', {
      title: 'Владелец блокировки',
      assigned_to: 'executor_1',
      status: 'in_progress',
      files: ['src/shared.js'],
      session_id: firstSessionId,
    });
    const firstTask = parseResponse(firstResponse);

    const conflictingResponse = await mockServer.callTool('task_create', {
      title: 'Конфликтующая задача',
      assigned_to: 'executor_1',
      status: 'in_progress',
      files: ['src/shared.js', 'src/should-not-lock.js'],
      session_id: secondSessionId,
    });

    expect(conflictingResponse.isError).toBe(true);
    expect(conflictingResponse.content?.[0]?.text ?? '').toContain('другой сессии');

    const conflictingTaskCount = dbState.db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE title = ?')
      .get('Конфликтующая задача');
    expect(conflictingTaskCount.count).toBe(0);

    const originalLock = dbState.db
      .prepare('SELECT task_id, locked_by FROM file_locks WHERE file = ?')
      .get('src/shared.js');
    expect(originalLock).toEqual({ task_id: firstTask.id, locked_by: 'executor_1' });

    const partialLock = dbState.db
      .prepare('SELECT task_id FROM file_locks WHERE file = ?')
      .get('src/should-not-lock.js');
    expect(partialLock).toBeUndefined();
  });
});
