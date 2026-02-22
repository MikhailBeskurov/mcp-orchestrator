// tools/builds.js — MCP-инструменты мониторинга сборок (v0.9)
import { z } from 'zod';
import { run, get, all } from '../db.js';
import { parseJsonField } from '../utils.js';

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 500;

/**
 * Преобразует строку сборки из БД в объект с распарсенными полями.
 * @param {object} row — строка из SELECT
 * @returns {object}
 */
function parseBuildRow(row) {
  if (!row) return row;
  return {
    ...row,
    success: !!row.success,
    errors: parseJsonField(row.errors),
    warnings: parseJsonField(row.warnings),
    related_tasks: parseJsonField(row.related_tasks),
  };
}

export function register(server) {
  // --- build_log ---
  server.registerTool(
    'build_log',
    {
      description: 'Записать результат сборки (успех/провал, ошибки, предупреждения, связанные задачи)',
      inputSchema: {
        session_id: z.number().int().positive().optional().describe('FK → sessions'),
        success: z.boolean().describe('Успех/провал сборки'),
        errors: z.array(z.string()).optional().describe('Список ошибок'),
        warnings: z.array(z.string()).optional().describe('Список предупреждений'),
        related_tasks: z.array(z.number().int().positive()).optional().describe('Связанные задачи (ID)'),
      },
    },
    async ({ session_id, success, errors, warnings, related_tasks }) => {
      try {
        if (session_id !== undefined) {
          const session = get('SELECT id FROM sessions WHERE id = ?', session_id);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Сессия с ID ${session_id} не найдена` }],
              isError: true,
            };
          }
        }

        const errorsStr = errors !== undefined ? JSON.stringify(errors) : null;
        const warningsStr = warnings !== undefined ? JSON.stringify(warnings) : null;
        const relatedTasksStr = related_tasks !== undefined ? JSON.stringify(related_tasks) : null;

        const result = run(
          `INSERT INTO builds (session_id, success, errors, warnings, related_tasks)
           VALUES (@session_id, @success, @errors, @warnings, @related_tasks)`,
          {
            session_id: session_id ?? null,
            success: success ? 1 : 0,
            errors: errorsStr,
            warnings: warningsStr,
            related_tasks: relatedTasksStr,
          }
        );

        const id = Number(result.lastInsertRowid);
        const row = get('SELECT * FROM builds WHERE id = ?', id);
        const parsed = parseBuildRow(row);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
        };
      } catch (err) {
        console.error('[build_log]', err);
        return {
          content: [{ type: 'text', text: `Ошибка записи результата сборки: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- build_history ---
  server.registerTool(
    'build_history',
    {
      description: 'История сборок с фильтрацией по сессии',
      inputSchema: {
        session_id: z.number().int().positive().optional().describe('Фильтр по сессии'),
        limit: z.number().int().positive().max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT).optional().describe('Лимит записей'),
      },
    },
    async ({ session_id, limit }) => {
      try {
        if (session_id !== undefined) {
          const session = get('SELECT id FROM sessions WHERE id = ?', session_id);
          if (!session) {
            return {
              content: [{ type: 'text', text: `Сессия с ID ${session_id} не найдена` }],
              isError: true,
            };
          }
        }

        const conditions = [];
        const params = {};
        if (session_id !== undefined) {
          conditions.push('session_id = @session_id');
          params.session_id = session_id;
        }
        params.limit = limit ?? DEFAULT_HISTORY_LIMIT;
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `SELECT * FROM builds ${whereClause} ORDER BY created_at DESC LIMIT @limit`;
        const rows = all(sql, params);
        const parsed = rows.map(parseBuildRow);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
        };
      } catch (err) {
        console.error('[build_history]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения истории сборок: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
