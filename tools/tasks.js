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
const ACTIVE_STATUSES = ['pending', 'in_progress'];
const TERMINAL_STATUSES = ['done', 'failed'];

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

/**
 * Нормализует пути и удаляет пустые значения/дубликаты, сохраняя порядок.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeFiles(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((file) => (typeof file === 'string' ? file.trim() : ''))
        .filter(Boolean)
    ),
  ];
}

/**
 * Нормализует JSON-поле files из строки БД.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeStoredFiles(value) {
  const parsed = Array.isArray(value) ? value : parseJsonField(value);
  return normalizeFiles(parsed);
}

/**
 * Сравнивает nullable session_id.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function isSameSession(left, right) {
  return (left ?? null) === (right ?? null);
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
          const existingIds = new Set(existing.map((row) => row.id));
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
        const normalizedFiles = normalizeFiles(files);
        const filesStr = files !== undefined ? JSON.stringify(normalizedFiles) : null;
        const dependsOnStr = depends_on !== undefined ? JSON.stringify(depends_on) : null;

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
          const id = Number(result.lastInsertRowid);
          const lockedFiles = [];

          if (normalizedFiles.length > 0) {
            const placeholders = normalizedFiles.map(() => '?').join(',');
            const existingLocks = all(
              `SELECT fl.file, fl.locked_by, fl.task_id,
                      t.session_id AS task_session_id, t.status AS task_status
               FROM file_locks fl
               LEFT JOIN tasks t ON t.id = fl.task_id
               WHERE fl.file IN (${placeholders})`,
              ...normalizedFiles
            );
            const existingByFile = new Map(existingLocks.map((row) => [row.file, row]));

            for (const normalizedFile of normalizedFiles) {
              const existing = existingByFile.get(normalizedFile);
              if (existing) {
                if (existing.locked_by !== assigned_to) {
                  throw new Error(
                    `Файл "${normalizedFile}" уже заблокирован агентом ${existing.locked_by}`
                  );
                }

                // Ручная блокировка того же агента остаётся ручной и не привязывается к задаче.
                if (existing.task_id === null) {
                  lockedFiles.push(normalizedFile);
                  continue;
                }

                // Подбираем зависшую блокировку завершённой/удалённой задачи.
                if (!existing.task_status || TERMINAL_STATUSES.includes(existing.task_status)) {
                  run('UPDATE file_locks SET task_id = ? WHERE file = ?', id, normalizedFile);
                  existingByFile.set(normalizedFile, {
                    ...existing,
                    task_id: id,
                    task_session_id: session_id ?? null,
                    task_status: status ?? 'pending',
                  });
                  lockedFiles.push(normalizedFile);
                  continue;
                }

                // Одна физическая блокировка не может безопасно представлять задачи разных сессий.
                if (!isSameSession(existing.task_session_id, session_id)) {
                  throw new Error(
                    `Файл "${normalizedFile}" уже используется активной задачей ${existing.task_id} ` +
                      `в другой сессии`
                  );
                }

                // В одной сессии несколько задач того же агента могут разделять блокировку.
                // task_update передаст владение следующей активной задаче перед завершением владельца.
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
              existingByFile.set(normalizedFile, {
                file: normalizedFile,
                locked_by: assigned_to,
                task_id: id,
                task_session_id: session_id ?? null,
                task_status: status ?? 'pending',
              });
            }
          }

          return { id, lockedFiles };
        });

        const row = get(
          `SELECT id, session_id, title, description, assigned_to, priority, status, result, files, depends_on, created_at, updated_at FROM tasks WHERE id = ?`,
          txResult.id
        );
        const task = parseTask(row);
        const response = { ...task, locked_files: txResult.lockedFiles };
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
        const existing = get('SELECT id, session_id FROM tasks WHERE id = ?', id);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Задача с ID ${id} не найдена` }],
            isError: true,
          };
        }

        let unlockedFiles = 0;
        let transferredFiles = 0;
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

          if (TERMINAL_STATUSES.includes(status)) {
            const ownedLocks = all(
              'SELECT file, locked_by FROM file_locks WHERE task_id = ? ORDER BY file ASC',
              id
            );

            if (ownedLocks.length > 0) {
              const candidates = all(
                `SELECT id, session_id, assigned_to, files
                 FROM tasks
                 WHERE id <> ? AND status IN ('pending', 'in_progress') AND files IS NOT NULL
                 ORDER BY id ASC`,
                id
              ).map((candidate) => ({
                ...candidate,
                normalized_files: normalizeStoredFiles(candidate.files),
              }));

              for (const lock of ownedLocks) {
                const replacement = candidates.find(
                  (candidate) =>
                    candidate.assigned_to === lock.locked_by &&
                    isSameSession(candidate.session_id, existing.session_id) &&
                    candidate.normalized_files.includes(lock.file)
                );

                if (replacement) {
                  const transferResult = run(
                    'UPDATE file_locks SET task_id = ? WHERE file = ? AND task_id = ?',
                    replacement.id,
                    lock.file,
                    id
                  );
                  transferredFiles += transferResult.changes ?? 0;
                  continue;
                }

                const deleteResult = run(
                  'DELETE FROM file_locks WHERE file = ? AND task_id = ?',
                  lock.file,
                  id
                );
                unlockedFiles += deleteResult.changes ?? 0;
              }
            }
          }
        });

        const row = get(
          `SELECT id, session_id, title, description, assigned_to, priority, status, result, files, depends_on, created_at, updated_at FROM tasks WHERE id = ?`,
          id
        );
        const task = parseTask(row);
        const response = {
          ...task,
          unlocked_files: unlockedFiles,
          transferred_files: transferredFiles,
        };
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

        const taskDetails = {
          ...task,
          reviews,
          messages,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(taskDetails) }],
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
