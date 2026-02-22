// tools/file_locks.js — MCP-инструменты файловых блокировок (v0.4)
import { z } from 'zod';
import { run, get, all, transaction } from '../db.js';

const LOCKED_BY = ['executor_1', 'executor_2', 'reviewer_impl', 'reviewer_arch'];

export function register(server) {
  // --- file_lock ---
  server.registerTool(
    'file_lock',
    {
      description: 'Заблокировать файл за агентом',
      inputSchema: {
        file: z.string().min(1).describe('Путь к файлу'),
        locked_by: z.enum(LOCKED_BY).describe('Агент, блокирующий файл'),
        task_id: z.number().int().positive().optional().describe('ID задачи (опционально)'),
      },
    },
    async ({ file, locked_by, task_id }) => {
      try {
        const normalizedFile = file.trim();
        if (!normalizedFile) {
          return {
            content: [{ type: 'text', text: 'Путь к файлу не может быть пустым' }],
            isError: true,
          };
        }

        // Проверка существования task_id при передаче
        if (task_id !== undefined) {
          const task = get('SELECT id FROM tasks WHERE id = ?', task_id);
          if (!task) {
            return {
              content: [{ type: 'text', text: `Задача с ID ${task_id} не найдена` }],
              isError: true,
            };
          }
        }

        let result;
        try {
          result = transaction(() => {
            const existing = get(
              'SELECT file, locked_by, task_id, locked_at FROM file_locks WHERE file = ?',
              normalizedFile
            );
            if (existing) {
              if (existing.locked_by !== locked_by) {
                return { error: `Файл уже заблокирован агентом ${existing.locked_by}` };
              }
              return {
                data: {
                  file: existing.file,
                  locked_by: existing.locked_by,
                  task_id: existing.task_id,
                  locked_at: existing.locked_at,
                },
              };
            }

            run(
              `INSERT INTO file_locks (file, locked_by, task_id) VALUES (@file, @locked_by, @task_id)`,
              {
                file: normalizedFile,
                locked_by,
                task_id: task_id ?? null,
              }
            );
            const row = get(
              'SELECT file, locked_by, task_id, locked_at FROM file_locks WHERE file = ?',
              normalizedFile
            );
            return { data: row };
          });
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE')) {
            return {
              content: [{ type: 'text', text: 'Файл уже заблокирован' }],
              isError: true,
            };
          }
          throw err;
        }

        if (result.error) {
          return {
            content: [{ type: 'text', text: result.error }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result.data) }],
        };
      } catch (err) {
        console.error('[file_lock]', err);
        return {
          content: [{ type: 'text', text: `Ошибка блокировки файла: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- file_unlock ---
  server.registerTool(
    'file_unlock',
    {
      description: 'Снять блокировку файла (только владельцем)',
      inputSchema: {
        file: z.string().min(1).describe('Путь к файлу'),
        locked_by: z.enum(LOCKED_BY).describe('Агент, снимающий блокировку'),
      },
    },
    async ({ file, locked_by }) => {
      try {
        const normalizedFile = file.trim();
        if (!normalizedFile) {
          return {
            content: [{ type: 'text', text: 'Путь к файлу не может быть пустым' }],
            isError: true,
          };
        }

        const existing = get('SELECT file, locked_by FROM file_locks WHERE file = ?', normalizedFile);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Блокировка для файла "${normalizedFile}" не найдена` }],
            isError: true,
          };
        }

        if (existing.locked_by !== locked_by) {
          return {
            content: [
              {
                type: 'text',
                text: `Файл заблокирован другим агентом (${existing.locked_by}). Снять блокировку может только владелец.`,
              },
            ],
            isError: true,
          };
        }

        run('DELETE FROM file_locks WHERE file = ?', normalizedFile);

        return {
          content: [{ type: 'text', text: JSON.stringify({ file: normalizedFile, unlocked: true }) }],
        };
      } catch (err) {
        console.error('[file_unlock]', err);
        return {
          content: [{ type: 'text', text: `Ошибка снятия блокировки: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- file_locks_list ---
  server.registerTool(
    'file_locks_list',
    {
      description: 'Получить список текущих блокировок файлов',
      inputSchema: {
        locked_by: z.enum(LOCKED_BY).optional().describe('Фильтр по агенту'),
        task_id: z.number().int().positive().optional().describe('Фильтр по задаче'),
      },
    },
    async ({ locked_by, task_id }) => {
      try {
        const conditions = [];
        const params = {};

        if (locked_by !== undefined) {
          conditions.push('locked_by = @locked_by');
          params.locked_by = locked_by;
        }
        if (task_id !== undefined) {
          conditions.push('task_id = @task_id');
          params.task_id = task_id;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT file, locked_by, task_id, locked_at FROM file_locks ${whereClause} ORDER BY locked_at DESC`;

        const rows = all(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[file_locks_list]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения списка блокировок: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
