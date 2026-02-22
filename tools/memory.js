// tools/memory.js — MCP-инструменты базы знаний (v0.6)
import { z } from 'zod';
import { run, get, all } from '../db.js';
import { parseJsonField } from '../utils.js';

const CATEGORY = ['architecture', 'bug', 'decision', 'convention', 'pattern', 'performance', 'gotcha'];
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Преобразует строку памяти из БД в объект с распарсенными tags и related_files.
 * @param {object} row — строка из SELECT
 * @returns {object}
 */
function parseMemoryRow(row) {
  if (!row) return row;
  return {
    ...row,
    tags: parseJsonField(row.tags),
    related_files: parseJsonField(row.related_files),
  };
}

export function register(server) {
  // --- memory_store ---
  server.registerTool(
    'memory_store',
    {
      description: 'Сохранить факт или решение в базу знаний проекта',
      inputSchema: {
        category: z.enum(CATEGORY).describe('Категория записи'),
        title: z.string().min(1).describe('Заголовок записи'),
        content: z.string().min(1).describe('Содержание записи'),
        tags: z.array(z.string()).optional().describe('Теги для поиска'),
        related_files: z.array(z.string()).optional().describe('Связанные файлы'),
      },
    },
    async ({ category, title, content, tags, related_files }) => {
      try {
        const titleNorm = title.trim();
        const contentNorm = content.trim();
        const tagsStr = tags !== undefined ? JSON.stringify(tags) : null;
        const relatedFilesStr = related_files !== undefined ? JSON.stringify(related_files) : null;

        const result = run(
          `INSERT INTO memory (category, title, content, tags, related_files)
           VALUES (@category, @title, @content, @tags, @related_files)`,
          {
            category,
            title: titleNorm,
            content: contentNorm,
            tags: tagsStr,
            related_files: relatedFilesStr,
          }
        );

        const id = Number(result.lastInsertRowid);
        const row = get('SELECT created_at FROM memory WHERE id = ?', id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, category, title: titleNorm, created_at: row.created_at }) }],
        };
      } catch (err) {
        console.error('[memory_store]', err);
        return {
          content: [{ type: 'text', text: `Ошибка сохранения в базу знаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- memory_search ---
  server.registerTool(
    'memory_search',
    {
      description: 'Поиск по базе знаний проекта',
      inputSchema: {
        query: z.string().optional().describe('Поисковый запрос (ищет в title, content, tags)'),
        category: z.enum(CATEGORY).optional().describe('Фильтр по категории'),
        limit: z.number().int().positive().max(500).default(DEFAULT_SEARCH_LIMIT).optional().describe('Максимальное количество записей'),
      },
    },
    async ({ query, category, limit }) => {
      try {
        const conditions = [];
        const params = {};

        if (query !== undefined) {
          const trimmed = query.trim();
          if (trimmed) {
            const escaped = trimmed.replace(/[%_]/g, '\\$&');
            conditions.push('(title LIKE @q ESCAPE \'\\\' OR content LIKE @q ESCAPE \'\\\' OR tags LIKE @q ESCAPE \'\\\')');
            params.q = '%' + escaped + '%';
          }
        }
        if (category !== undefined) {
          conditions.push('category = @category');
          params.category = category;
        }

        params.limit = limit ?? DEFAULT_SEARCH_LIMIT;
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT id, category, title, content, tags, related_files, created_at, updated_at
                     FROM memory ${whereClause} ORDER BY updated_at DESC LIMIT @limit`;

        const rows = all(sql, params);
        const parsed = rows.map(parseMemoryRow);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
        };
      } catch (err) {
        console.error('[memory_search]', err);
        return {
          content: [{ type: 'text', text: `Ошибка поиска в базе знаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- memory_delete ---
  server.registerTool(
    'memory_delete',
    {
      description: 'Удалить запись из базы знаний',
      inputSchema: {
        id: z.number().int().positive().describe('ID записи'),
      },
    },
    async ({ id }) => {
      try {
        const existing = get('SELECT id FROM memory WHERE id = ?', id);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Запись с ID ${id} не найдена` }],
            isError: true,
          };
        }

        run('DELETE FROM memory WHERE id = ?', id);
        return {
          content: [{ type: 'text', text: JSON.stringify({ id, deleted: true }) }],
        };
      } catch (err) {
        console.error('[memory_delete]', err);
        return {
          content: [{ type: 'text', text: `Ошибка удаления из базы знаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
