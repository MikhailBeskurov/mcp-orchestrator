// tools/sessions.js — MCP-инструменты управления сессиями оркестрации (v0.7)
import { z } from 'zod';
import { run, get, all, transaction } from '../db.js';

export const SESSION_STATUS = ['active', 'completed', 'abandoned'];
export const SESSION_UPDATE_STATUS = SESSION_STATUS.filter((s) => s !== 'active');
export const EVENT_TYPE = [
  'task_created',
  'task_started',
  'task_completed',
  'task_failed',
  'review_started',
  'review_completed',
  'build_started',
  'build_success',
  'build_failed',
  'session_paused',
  'session_resumed',
  'note',
];
export const DEFAULT_HISTORY_LIMIT = 50;

export function register(server) {
  // --- session_start ---
  server.registerTool(
    'session_start',
    {
      description: 'Создать новую сессию оркестрации',
      inputSchema: {
        goal: z.string().min(1).describe('Цель сессии'),
        plan: z.string().optional().describe('План выполнения'),
      },
    },
    async ({ goal, plan }) => {
      try {
        const goalNorm = goal.trim();
        if (!goalNorm) {
          return {
            content: [{ type: 'text', text: 'Цель сессии не может быть пустой' }],
            isError: true,
          };
        }
        const planNorm = plan !== undefined ? (plan.trim() || null) : null;

        // Очистка orphaned-состояний перед созданием новой сессии
        const cleanupResult = transaction(() => {
          const abandoned = all("SELECT id FROM sessions WHERE status = 'abandoned'");
          const abandonedIds = abandoned.map((r) => r.id);
          let unlocked_files = 0;
          let failed_tasks = 0;

          if (abandonedIds.length > 0) {
            const placeholders = abandonedIds.map(() => '?').join(',');
            const delLocks = run(
              `DELETE FROM file_locks WHERE task_id IN (SELECT id FROM tasks WHERE session_id IN (${placeholders}))`,
              ...abandonedIds
            );
            const updTasks = run(
              `UPDATE tasks SET status = 'failed', result = 'Orphaned: сессия была abandoned', updated_at = CURRENT_TIMESTAMP
               WHERE session_id IN (${placeholders}) AND status IN ('pending', 'in_progress')`,
              ...abandonedIds
            );
            unlocked_files += delLocks.changes;
            failed_tasks += updTasks.changes;
          }

          // Бесхозные блокировки — задачи без существующей сессии
          const orphanLocks = run(
            `DELETE FROM file_locks WHERE task_id IN (
              SELECT t.id FROM tasks t
              LEFT JOIN sessions s ON t.session_id = s.id
              WHERE s.id IS NULL AND t.session_id IS NOT NULL
            )`
          );
          unlocked_files += orphanLocks.changes;

          return { unlocked_files, failed_tasks };
        });

        if (cleanupResult.unlocked_files > 0 || cleanupResult.failed_tasks > 0) {
          console.log(
            `[session_start] Очистка orphaned: ${cleanupResult.unlocked_files} блокировок, ${cleanupResult.failed_tasks} задач`
          );
        }

        const result = run(
          'INSERT INTO sessions (goal, plan) VALUES (@goal, @plan)',
          { goal: goalNorm, plan: planNorm }
        );
        const id = Number(result.lastInsertRowid);
        const row = get('SELECT * FROM sessions WHERE id = ?', id);
        const response = { ...row };
        if (cleanupResult.unlocked_files > 0 || cleanupResult.failed_tasks > 0) {
          response.cleanup = {
            unlocked_files: cleanupResult.unlocked_files,
            failed_tasks: cleanupResult.failed_tasks,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      } catch (err) {
        console.error('[session_start]', err);
        return {
          content: [{ type: 'text', text: `Ошибка создания сессии: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- session_update ---
  server.registerTool(
    'session_update',
    {
      description: 'Обновить статус сессии (завершить или забросить)',
      inputSchema: {
        id: z.number().int().positive().describe('ID сессии'),
        status: z.enum(SESSION_UPDATE_STATUS).describe('Новый статус'),
      },
    },
    async ({ id, status }) => {
      try {
        const session = get('SELECT * FROM sessions WHERE id = ?', id);
        if (!session) {
          return {
            content: [{ type: 'text', text: `Сессия с ID ${id} не найдена` }],
            isError: true,
          };
        }
        if (session.status !== 'active') {
          return {
            content: [
              {
                type: 'text',
                text: `Сессия уже завершена (статус: ${session.status})`,
              },
            ],
            isError: true,
          };
        }

        const { unlocked_files, failed_tasks } = transaction(() => {
          run(
            'UPDATE sessions SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
            { status, id }
          );
          const delLocks = run(
            'DELETE FROM file_locks WHERE task_id IN (SELECT id FROM tasks WHERE session_id = @id)',
            { id }
          );
          const resultText = status === 'completed' ? 'Сессия завершена (completed)' : 'Сессия заброшена (abandoned)';
          const updTasks = run(
            `UPDATE tasks SET status = 'failed', result = @result, updated_at = CURRENT_TIMESTAMP
             WHERE session_id = @id AND status IN ('pending', 'in_progress')`,
            { id, result: resultText }
          );
          return {
            unlocked_files: delLocks.changes,
            failed_tasks: updTasks.changes,
          };
        });

        const updated = get('SELECT * FROM sessions WHERE id = ?', id);
        const result = { ...updated, cleanup: { unlocked_files, failed_tasks } };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        console.error('[session_update]', err);
        return {
          content: [
            {
              type: 'text',
              text: `Ошибка обновления сессии: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- session_log ---
  server.registerTool(
    'session_log',
    {
      description: 'Записать событие в лог сессии',
      inputSchema: {
        session_id: z.number().int().positive().describe('ID сессии'),
        event_type: z.enum(EVENT_TYPE).describe('Тип события'),
        content: z.string().min(1).describe('Содержание события'),
      },
    },
    async ({ session_id, event_type, content }) => {
      try {
        const session = get('SELECT id FROM sessions WHERE id = ?', session_id);
        if (!session) {
          return {
            content: [{ type: 'text', text: `Сессия с ID ${session_id} не найдена` }],
            isError: true,
          };
        }
        const contentNorm = content.trim();
        if (!contentNorm) {
          return {
            content: [{ type: 'text', text: 'Содержание события не может быть пустым' }],
            isError: true,
          };
        }

        const result = run(
          'INSERT INTO session_log (session_id, event_type, content) VALUES (@session_id, @event_type, @content)',
          { session_id, event_type, content: contentNorm }
        );
        const id = Number(result.lastInsertRowid);
        const row = get('SELECT * FROM session_log WHERE id = ?', id);
        return {
          content: [{ type: 'text', text: JSON.stringify(row) }],
        };
      } catch (err) {
        console.error('[session_log]', err);
        return {
          content: [{ type: 'text', text: `Ошибка записи в лог сессии: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- session_history ---
  server.registerTool(
    'session_history',
    {
      description: 'Получить историю сессий или детали конкретной сессии с логом',
      inputSchema: {
        session_id: z.number().int().positive().optional().describe('ID сессии (если задан — вернёт сессию с логом)'),
        status: z.enum(SESSION_STATUS).optional().describe('Фильтр по статусу (только для списка)'),
        limit: z.number().int().positive().max(500).default(DEFAULT_HISTORY_LIMIT).optional().describe('Лимит записей в списке'),
      },
    },
    async ({ session_id, status, limit }) => {
      try {
        if (session_id !== undefined) {
          const session = get('SELECT * FROM sessions WHERE id = ?', session_id);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Сессия с ID ${session_id} не найдена` }],
              isError: true,
            };
          }
          const logs = all(
            'SELECT * FROM session_log WHERE session_id = ? ORDER BY created_at ASC',
            session_id
          );
          const result = { ...session, logs };
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }

        const conditions = [];
        const params = {};
        if (status !== undefined) {
          conditions.push('status = @status');
          params.status = status;
        }
        params.limit = limit ?? DEFAULT_HISTORY_LIMIT;
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT * FROM sessions ${whereClause} ORDER BY created_at DESC LIMIT @limit`;
        const rows = all(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[session_history]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения истории сессий: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
