// tools/messages.js — MCP-инструменты межагентной коммуникации (v0.8)
import { z } from 'zod';
import { run, get, all, transaction } from '../db.js';

export const AGENT = ['orchestrator', 'executor_1', 'executor_2', 'reviewer_impl', 'reviewer_arch'];
export const MESSAGE_TYPE = ['info', 'question', 'blocker', 'done'];
export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 500;

export function register(server) {
  // --- message_send ---
  server.registerTool(
    'message_send',
    {
      description: 'Отправить сообщение другому агенту/оркестратору',
      inputSchema: {
        from_agent: z.enum(AGENT).describe('Отправитель'),
        to_agent: z.enum(AGENT).describe('Получатель'),
        task_id: z.number().int().positive().optional().describe('Контекст задачи'),
        type: z.enum(MESSAGE_TYPE).default('info').optional().describe('Тип сообщения'),
        content: z.string().min(1).describe('Содержание сообщения'),
      },
    },
    async ({ from_agent, to_agent, task_id, type, content }) => {
      try {
        const contentNorm = content.trim();
        if (!contentNorm) {
          return {
            content: [{ type: 'text', text: 'Содержание сообщения не может быть пустым' }],
            isError: true,
          };
        }

        if (task_id !== undefined) {
          const task = get('SELECT id FROM tasks WHERE id = ?', task_id);
          if (!task) {
            return {
              content: [{ type: 'text', text: `Задача с ID ${task_id} не найдена` }],
              isError: true,
            };
          }
        }

        const typeVal = type ?? 'info';
        const result = run(
          'INSERT INTO messages (from_agent, to_agent, task_id, type, content) VALUES (@from_agent, @to_agent, @task_id, @type, @content)',
          {
            from_agent,
            to_agent,
            task_id: task_id ?? null,
            type: typeVal,
            content: contentNorm,
          }
        );
        const id = Number(result.lastInsertRowid);
        const row = get('SELECT * FROM messages WHERE id = ?', id);
        return {
          content: [{ type: 'text', text: JSON.stringify(row) }],
        };
      } catch (err) {
        console.error('[message_send]', err);
        return {
          content: [{ type: 'text', text: `Ошибка отправки сообщения: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- message_read ---
  server.registerTool(
    'message_read',
    {
      description: 'Чтение сообщений для роли',
      inputSchema: {
        role: z.enum(AGENT).describe('Роль получателя'),
        task_id: z.number().int().positive().optional().describe('Фильтр по задаче'),
        unread_only: z.boolean().default(true).optional().describe('Только непрочитанные'),
        limit: z.number().int().positive().max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT).optional().describe('Лимит сообщений'),
      },
    },
    async ({ role, task_id, unread_only, limit }) => {
      try {
        const conditions = ['to_agent = @role'];
        const params = { role };
        if (unread_only !== false) {
          conditions.push('read = 0');
        }
        if (task_id !== undefined) {
          conditions.push('task_id = @task_id');
          params.task_id = task_id;
        }
        params.limit = limit ?? DEFAULT_READ_LIMIT;

        const whereClause = conditions.join(' AND ');
        const sql = `SELECT * FROM messages WHERE ${whereClause} ORDER BY created_at ASC LIMIT @limit`;

        const rows = transaction(() => {
          const result = all(sql, params);
          if (result.length > 0) {
            const ids = result.map((r) => r.id);
            const placeholders = ids.map(() => '?').join(', ');
            run(`UPDATE messages SET read = 1 WHERE id IN (${placeholders})`, ...ids);
          }
          return result;
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[message_read]', err);
        return {
          content: [{ type: 'text', text: `Ошибка чтения сообщений: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
