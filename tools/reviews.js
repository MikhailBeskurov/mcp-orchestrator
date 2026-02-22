// tools/reviews.js — MCP-инструменты код-ревью (v0.3)
import { z } from 'zod';
import { run, get, all, transaction } from '../db.js';

const REVIEWER = ['reviewer_impl', 'reviewer_arch'];
const PRIORITY = ['normal', 'high', 'critical'];
const STATUS = ['open', 'fixed', 'wontfix'];
const RESOLVE_STATUS = ['fixed', 'wontfix'];
const CATEGORY = ['bug', 'performance', 'architecture', 'hardcode', 'modding', 'style', 'missing_feature'];

/**
 * Валидация одного элемента ревью.
 * @param {object} item — элемент замечания
 * @param {number} index — индекс в массиве (для сообщений об ошибках)
 * @param {Set<number>} validTaskIds — множество существующих task_id
 * @returns {{ valid: boolean, error?: string }}
 */
function validateReviewItem(item, index, validTaskIds) {
  if (!validTaskIds.has(item.task_id)) {
    return { valid: false, error: `Элемент [${index}]: задача с ID ${item.task_id} не найдена` };
  }
  if ((item.line_start !== undefined || item.line_end !== undefined) && !item.file) {
    return { valid: false, error: `Элемент [${index}]: при указании line_start или line_end необходимо указать file` };
  }
  if (item.line_start !== undefined && item.line_end !== undefined && item.line_end < item.line_start) {
    return { valid: false, error: `Элемент [${index}]: line_end должен быть >= line_start` };
  }
  return { valid: true };
}

export function register(server) {
  // --- review_submit ---
  server.registerTool(
    'review_submit',
    {
      description: 'Отправить замечание код-ревью по задаче',
      inputSchema: {
        task_id: z.number().int().positive().describe('ID задачи'),
        reviewer: z.enum(REVIEWER).describe('Ревьюер'),
        file: z.string().optional().describe('Путь к файлу'),
        line_start: z.number().int().positive().optional().describe('Начальная строка'),
        line_end: z.number().int().positive().optional().describe('Конечная строка'),
        priority: z.enum(PRIORITY).default('normal').describe('Приоритет'),
        category: z.enum(CATEGORY).optional().describe('Категория замечания'),
        description: z.string().min(1).describe('Текст замечания'),
        suggestion: z.string().optional().describe('Предлагаемое исправление'),
      },
    },
    async ({ task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion }) => {
      try {
        const task = get('SELECT id FROM tasks WHERE id = ?', task_id);
        if (!task) {
          return {
            content: [{ type: 'text', text: `Задача с ID ${task_id} не найдена` }],
            isError: true,
          };
        }

        if ((line_start !== undefined || line_end !== undefined) && !file) {
          return {
            content: [{ type: 'text', text: 'При указании line_start или line_end необходимо указать file' }],
            isError: true,
          };
        }

        if (line_start !== undefined && line_end !== undefined && line_end < line_start) {
          return {
            content: [{ type: 'text', text: 'line_end должен быть >= line_start' }],
            isError: true,
          };
        }

        const result = run(
          `INSERT INTO reviews (task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion)
           VALUES (@task_id, @reviewer, @file, @line_start, @line_end, @priority, @category, @description, @suggestion)`,
          {
            task_id,
            reviewer,
            file: (file && file.trim()) || null,
            line_start: line_start ?? null,
            line_end: line_end ?? null,
            priority: priority ?? 'normal',
            category: category ?? null,
            description,
            suggestion: suggestion ?? null,
          }
        );

        const id = Number(result.lastInsertRowid);
        const row = get('SELECT * FROM reviews WHERE id = ?', id);
        return {
          content: [{ type: 'text', text: JSON.stringify(row) }],
        };
      } catch (err) {
        console.error('[review_submit]', err);
        return {
          content: [{ type: 'text', text: `Ошибка отправки замечания: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- review_list ---
  server.registerTool(
    'review_list',
    {
      description: 'Получить список замечаний с фильтрацией',
      inputSchema: {
        task_id: z.number().int().positive().optional().describe('Фильтр по задаче'),
        file: z.string().optional().describe('Фильтр по файлу'),
        priority: z.enum(PRIORITY).optional().describe('Фильтр по приоритету'),
        status: z.enum(STATUS).optional().describe('Фильтр по статусу'),
        reviewer: z.enum(REVIEWER).optional().describe('Фильтр по ревьюеру'),
        category: z.enum(CATEGORY).optional().describe('Фильтр по категории'),
        limit: z.number().int().positive().max(1000).default(100).optional().describe('Максимальное количество записей'),
      },
    },
    async ({ task_id, file, priority, status, reviewer, category, limit }) => {
      try {
        const conditions = [];
        const params = {};

        if (task_id !== undefined) {
          conditions.push('task_id = @task_id');
          params.task_id = task_id;
        }
        if (file !== undefined) {
          const trimmed = file.trim();
          if (trimmed) {
            conditions.push('file = @file');
            params.file = trimmed;
          }
        }
        if (priority !== undefined) {
          conditions.push('priority = @priority');
          params.priority = priority;
        }
        if (status !== undefined) {
          conditions.push('status = @status');
          params.status = status;
        }
        if (reviewer !== undefined) {
          conditions.push('reviewer = @reviewer');
          params.reviewer = reviewer;
        }
        if (category !== undefined) {
          conditions.push('category = @category');
          params.category = category;
        }

        params.limit = limit ?? 100;
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT id, task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion, status, resolve_comment, created_at
                     FROM reviews ${whereClause} ORDER BY created_at DESC LIMIT @limit`;

        const rows = all(sql, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[review_list]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения списка замечаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- review_resolve ---
  server.registerTool(
    'review_resolve',
    {
      description: 'Пометить замечание как исправленное или отклонённое',
      inputSchema: {
        id: z.number().int().positive().describe('ID замечания'),
        status: z.enum(RESOLVE_STATUS).describe('Новый статус'),
        resolve_comment: z.string().optional().describe('Комментарий к решению'),
      },
    },
    async ({ id, status, resolve_comment }) => {
      try {
        const existing = get('SELECT id, status FROM reviews WHERE id = ?', id);
        if (!existing) {
          return {
            content: [{ type: 'text', text: `Замечание с ID ${id} не найдено` }],
            isError: true,
          };
        }

        if (existing.status !== 'open') {
          return {
            content: [{ type: 'text', text: `Замечание уже закрыто (статус: ${existing.status})` }],
            isError: true,
          };
        }

        if (resolve_comment !== undefined) {
          run(
            `UPDATE reviews SET status = @status, resolve_comment = @resolve_comment WHERE id = @id`,
            { status, resolve_comment: resolve_comment ?? null, id }
          );
        } else {
          run(
            `UPDATE reviews SET status = @status WHERE id = @id`,
            { status, id }
          );
        }

        const row = get(
          `SELECT id, task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion, status, resolve_comment, created_at
           FROM reviews WHERE id = ?`,
          id
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(row) }],
        };
      } catch (err) {
        console.error('[review_resolve]', err);
        return {
          content: [{ type: 'text', text: `Ошибка обновления замечания: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- review_submit_batch ---
  server.registerTool(
    'review_submit_batch',
    {
      description: 'Батч-отправка замечаний код-ревью (все или ничего)',
      inputSchema: {
        reviews: z
          .array(
            z.object({
              task_id: z.number().int().positive().describe('ID задачи'),
              reviewer: z.enum(REVIEWER).describe('Ревьюер'),
              file: z.string().optional().describe('Путь к файлу'),
              line_start: z.number().int().positive().optional().describe('Начальная строка'),
              line_end: z.number().int().positive().optional().describe('Конечная строка'),
              priority: z.enum(PRIORITY).default('normal').describe('Приоритет'),
              category: z.enum(CATEGORY).optional().describe('Категория замечания'),
              description: z.string().min(1).describe('Текст замечания'),
              suggestion: z.string().optional().describe('Предлагаемое исправление'),
            })
          )
          .min(1)
          .describe('Массив замечаний'),
      },
    },
    async ({ reviews }) => {
      try {
        const uniqueTaskIds = [...new Set(reviews.map((r) => r.task_id))];
        const placeholders = uniqueTaskIds.map(() => '?').join(',');
        const existingTasks = all(`SELECT id FROM tasks WHERE id IN (${placeholders})`, ...uniqueTaskIds);
        const validTaskIds = new Set(existingTasks.map((r) => r.id));

        for (let i = 0; i < reviews.length; i++) {
          const check = validateReviewItem(reviews[i], i, validTaskIds);
          if (!check.valid) {
            return { content: [{ type: 'text', text: check.error }], isError: true };
          }
        }

        const ids = transaction(() => {
          const insertedIds = [];
          for (const r of reviews) {
            const result = run(
              `INSERT INTO reviews (task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion)
               VALUES (@task_id, @reviewer, @file, @line_start, @line_end, @priority, @category, @description, @suggestion)`,
              {
                task_id: r.task_id,
                reviewer: r.reviewer,
                file: (r.file && r.file.trim()) || null,
                line_start: r.line_start ?? null,
                line_end: r.line_end ?? null,
                priority: r.priority ?? 'normal',
                category: r.category ?? null,
                description: r.description,
                suggestion: r.suggestion ?? null,
              }
            );
            insertedIds.push(Number(result.lastInsertRowid));
          }
          return insertedIds;
        });

        const ph = ids.map(() => '?').join(',');
        const allRows = all(`SELECT * FROM reviews WHERE id IN (${ph})`, ...ids);
        const byId = new Map(allRows.map((r) => [r.id, r]));
        const rows = ids.map((id) => byId.get(id));

        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[review_submit_batch]', err);
        return {
          content: [{ type: 'text', text: `Ошибка батч-отправки замечаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- review_resolve_batch ---
  server.registerTool(
    'review_resolve_batch',
    {
      description: 'Батч-закрытие замечаний код-ревью (все или ничего)',
      inputSchema: {
        resolutions: z
          .array(
            z.object({
              id: z.number().int().positive().describe('ID замечания'),
              status: z.enum(RESOLVE_STATUS).describe('Новый статус'),
              resolve_comment: z.string().optional().describe('Комментарий к решению'),
            })
          )
          .min(1)
          .describe('Массив закрываемых замечаний'),
      },
    },
    async ({ resolutions }) => {
      try {
        const uniqueIds = [...new Set(resolutions.map((r) => r.id))];
        const placeholders = uniqueIds.map(() => '?').join(',');
        const existingReviews = all(`SELECT id, status FROM reviews WHERE id IN (${placeholders})`, ...uniqueIds);
        const reviewMap = new Map(existingReviews.map((r) => [r.id, r]));

        for (let i = 0; i < resolutions.length; i++) {
          const r = resolutions[i];
          const existing = reviewMap.get(r.id);
          if (!existing) {
            return {
              content: [{ type: 'text', text: `Элемент [${i}]: замечание с ID ${r.id} не найдено` }],
              isError: true,
            };
          }
          if (existing.status !== 'open') {
            return {
              content: [
                {
                  type: 'text',
                  text: `Элемент [${i}]: замечание с ID ${r.id} уже закрыто (статус: ${existing.status})`,
                },
              ],
              isError: true,
            };
          }
        }

        transaction(() => {
          for (const r of resolutions) {
            if (r.resolve_comment !== undefined) {
              run(
                `UPDATE reviews SET status = @status, resolve_comment = @resolve_comment WHERE id = @id`,
                { status: r.status, resolve_comment: r.resolve_comment ?? null, id: r.id }
              );
            } else {
              run(`UPDATE reviews SET status = @status WHERE id = @id`, { status: r.status, id: r.id });
            }
          }
        });

        const allIds = resolutions.map((r) => r.id);
        const ph = allIds.map(() => '?').join(',');
        const allRows = all(
          `SELECT id, task_id, reviewer, file, line_start, line_end, priority, category, description, suggestion, status, resolve_comment, created_at
           FROM reviews WHERE id IN (${ph})`,
          ...allIds
        );
        const byId = new Map(allRows.map((r) => [r.id, r]));
        const rows = resolutions.map((r) => byId.get(r.id));

        return {
          content: [{ type: 'text', text: JSON.stringify(rows) }],
        };
      } catch (err) {
        console.error('[review_resolve_batch]', err);
        return {
          content: [{ type: 'text', text: `Ошибка батч-закрытия замечаний: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
