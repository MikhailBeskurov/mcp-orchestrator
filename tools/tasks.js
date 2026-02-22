// tools/tasks.js — MCP-инструменты управления задачами (v0.3)
import { z } from 'zod';
import { run, get, all, transaction } from '../db.js';
import { parseJsonField } from '../utils.js';

// Константы enum для переиспользования
const ASSIGNED_TO = ['executor_1', 'executor_2', 'reviewer_impl', 'reviewer_arch', 'orchestrator'];
const PRIORITY = ['low', 'normal', 'high', 'critical'];
const STATUS_PENDING = ['pending', 'in_progress', 'done', 'failed'];
const STATUS_UPDATE = ['in_progress', 'done', 'failed'];
const STATUS_CREATE = ['pending', 'in_progress'];

/**
 * Преобразует строку задачи из БД в объект с распарсенными files и depends_on.
 * @param {object} row — строка из SELECT
 * @returns {object}
 */
function parseTask(row) {
  if (!row) return row;
  return {
    ...row,
    files: parseJsonField(row.files),
    depends_on: parseJsonField(row.depends_on),
  };
}

export function register(server) {
  // --- task_create ---
  server.registerTool(
    'task_create',
    {
      description: 'Создать задачу и назначить агенту',
      inputSchema: {
        title: z.string().min(1).describe('Краткое название задачи'),
        description: z.string().optional().describe('Описание задачи'),
        assigned_to: z.enum(ASSIGNED_TO).describe('Агент-исполнитель'),
        priority: z.enum(PRIORITY).default('normal').describe('Приоритет'),
        status: z.enum(STATUS_CREATE).default('pending').optional().describe('Начальный статус задачи'),
        files: z.array(z.string()).optional().describe('Список файлов задачи'),
        depends_on: z.array(z.number().int().positive()).optional().describe('ID задач-зависимостей'),
        session_id: z.number().int().positive().optional().describe('ID сессии'),
      },
    },
    async ({ title, description, assigned_to, priority, status, files, depends_on, session_id }) => {
      try {
        // 1. Проверка depends_on — все задачи должны существовать
        if (depends_on && depends_on.length > 0) {
          const placeholders = depends_on.map(() => '?').join(',');
          const existing = all(`SELECT id FROM tasks WHERE id IN (${placeholders})`, ...depends_on);
          const existingIds = new Set(existing.map((r) => r.id));
          const missing = depends_on.filter((id) => !existingIds.has(id));
          if (missing.length > 0) {
            return {
              content: [{ type: 'text', text: `Несуществующие задачи-зависимости: ${missing.join(', ')}` }],
              isError: true,
            };
          }
        }

        // 2. Проверка session_id
        if (session_id !== undefined) {
          const session = get('SELECT id FROM sessions WHERE id = ?', session_id);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Сессия с ID ${session_id} не найдена` }],
              isError: true,
            };
          }
        }

        // 3. INSERT задачи + автоблокировка файлов (в транзакции)
        const filesStr = files !== undefined ? JSON.stringify(files) : null;
        const dependsOnStr = depends_on !== undefined ? JSON.stringify(depends_on) : null;

        let id;
        let lockedFiles = [];

        const txResult = transaction(() => {
          const result = run(
            `INSERT INTO tasks (title, description, assigned_to, priority, status, files, depends_on, session_id)
             VALUES (@title, @description, @assigned_to, @priority, @status, @files, @depends_on, @session_id)`,
            {
              title,
              description: description ?? null,
              assigned_to,
              priority: priority ?? 'normal',
              status: status ?? 'pending',
              files: filesStr,
              depends_on: dependsOnStr,
              session_id: session_id ?? null,
            }
          );
          id = Number(result.lastInsertRowid);

          // Автоблокировка файлов при наличии
          if (files && files.length > 0) {
            const normalizedFiles = files
              .map((f) => (typeof f === 'string' ? f.trim() : ''))
              .filter(Boolean);

            if (normalizedFiles.length > 0) {
              const uniqueFiles = [...new Set(normalizedFiles)];
              const placeholders = uniqueFiles.map(() => '?').join(',');
              const existingLocks = all(
                `SELECT file, locked_by FROM file_locks WHERE file IN (${placeholders})`,
                ...uniqueFiles
              );
              const existingByFile = new Map(existingLocks.map((r) => [r.file, r]));

              for (const normalizedFile of normalizedFiles) {
                const existing = existingByFile.get(normalizedFile);
                if (existing) {
                  if (existing.locked_by !== assigned_to) {
                    throw new Error(
                      `Файл "${normalizedFile}" уже заблокирован агентом ${existing.locked_by}`
                    );
                  }
                  lockedFiles.push(normalizedFile);
                  continue;
                }

                run(
                  `INSERT INTO file_locks (file, locked_by, task_id) VALUES (@file, @locked_by, @task_id)`,
                  {
                    file: normalizedFile,
                    locked_by: assigned_to,
                    task_id: id,
                  }
                );
                lockedFiles.push(normalizedFile);
                existingByFile.set(normalizedFile, { locked_by: assigned_to });
              }
            }
          }
          return { id, lockedFiles };
        });

        id = txResult.id;
        lockedFiles = txResult.lockedFiles;

        const row = get(
          `SELECT id, session_id, title, description, assigned_to, priority, status, result, files, depends_on, created_at, updated_at FROM tasks WHERE id = ?`,
          id
        );
        const task = parseTask(row);
        const response = { ...task, locked_files: lockedFiles };
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      } catch (err) {
        console.error('[task_create]', err);
        return {
          content: [{ type: 'text', text: `Ошибка создания задачи: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- task_list ---
  server.registerTool(
    'task_list',
    {
      description: 'Получить список задач с фильтрацией',
      inputSchema: {
        status: z.enum(STATUS_PENDING).optional().describe('Фильтр по статусу'),
        assigned_to: z.enum(ASSIGNED_TO).optional().describe('Фильтр по агенту'),
        session_id: z.number().int().positive().optional().describe('Фильтр по сессии'),
      },
    },
    async ({ status, assigned_to, session_id }) => {
      try {
        const conditions = [];
        const params = {};

        if (status !== undefined) {
          conditions.push('status = @status');
          params.status = status;
        }
        if (assigned_to !== undefined) {
          conditions.push('assigned_to = @assigned_to');
          params.assigned_to = assigned_to;
        }
        if (session_id !== undefined) {
          conditions.push('session_id = @session_id');
          params.session_id = session_id;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT id, title, status, assigned_to, priority, created_at, updated_at
                     FROM tasks ${whereClause} ORDER BY created_at DESC`;

        const rows = all(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[task_list]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения списка задач: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- task_update ---
  server.registerTool(
    'task_update',
    {
      description: 'Обновить статус задачи',
      inputSchema: {
        id: z.number().int().positive().describe('ID задачи'),
        status: z.enum(STATUS_UPDATE).describe('Новый статус'),
        result: z.string().optional().describe('Описание результата / причина провала'),
      },
    },
    async ({ id, status, result }) => {
      try {
        const existing = get('SELECT id FROM tasks WHERE id = ?', id);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Задача с ID ${id} не найдена` }],
            isError: true,
          };
        }

        let unlockedFiles = 0;
        transaction(() => {
          if (result !== undefined) {
            run(
              `UPDATE tasks SET status = @status, result = @result, updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
              { status, result, id }
            );
          } else {
            run(
              `UPDATE tasks SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
              { status, id }
            );
          }
          if (status === 'done' || status === 'failed') {
            const delResult = run('DELETE FROM file_locks WHERE task_id = ?', id);
            unlockedFiles = delResult.changes ?? 0;
          }
        });

        const row = get(
          `SELECT id, session_id, title, description, assigned_to, priority, status, result, files, depends_on, created_at, updated_at FROM tasks WHERE id = ?`,
          id
        );
        const task = parseTask(row);
        const response = { ...task, unlocked_files: unlockedFiles };
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      } catch (err) {
        console.error('[task_update]', err);
        return {
          content: [{ type: 'text', text: `Ошибка обновления задачи: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- task_get ---
  server.registerTool(
    'task_get',
    {
      description: 'Получить полную информацию о задаче с ревью и сообщениями',
      inputSchema: {
        id: z.number().int().positive().describe('ID задачи'),
      },
    },
    async ({ id }) => {
      try {
        const row = get(
          `SELECT id, session_id, title, description, assigned_to, priority, status, result, files, depends_on, created_at, updated_at FROM tasks WHERE id = ?`,
          id
        );
        if (!row) {
          return {
            content: [{ type: 'text', text: `Задача с ID ${id} не найдена` }],
            isError: true,
          };
        }

        const task = parseTask(row);
        const reviews = all('SELECT * FROM reviews WHERE task_id = ?', id);
        const messages = all('SELECT * FROM messages WHERE task_id = ?', id);

        const result = {
          ...task,
          reviews,
          messages,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        console.error('[task_get]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения задачи: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
