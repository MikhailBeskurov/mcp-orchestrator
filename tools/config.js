// tools/config.js — MCP-инструменты конфигурации (v1.0)
import { z } from 'zod';
import { run, get, all } from '../db.js';

export function register(server) {
  // --- config_get ---
  server.registerTool(
    'config_get',
    {
      description: 'Получение настройки по ключу или всех настроек',
      inputSchema: {
        key: z.string().optional().describe('Ключ настройки (если не передан — все настройки)'),
      },
    },
    async ({ key }) => {
      try {
        if (key != null) {
          const keyNorm = key.trim();
          if (!keyNorm) {
            return {
              content: [{ type: 'text', text: 'Ключ не может быть пустым' }],
              isError: true,
            };
          }

          const row = get('SELECT key, value FROM config WHERE key = ?', keyNorm);
          if (!row) {
            return {
              content: [{ type: 'text', text: `Настройка с ключом "${keyNorm}" не найдена` }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({ key: row.key, value: row.value }) }],
          };
        }

        const rows = all('SELECT key, value FROM config ORDER BY key');
        return {
          content: [{ type: 'text', text: JSON.stringify(rows.map((r) => ({ key: r.key, value: r.value }))) }],
        };
      } catch (err) {
        console.error('[config_get]', err);
        return {
          content: [{ type: 'text', text: `Ошибка получения настройки: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- config_set ---
  server.registerTool(
    'config_set',
    {
      description: 'Установка настройки',
      inputSchema: {
        key: z.string().describe('Ключ настройки'),
        value: z.string().describe('Значение настройки'),
      },
    },
    async ({ key, value }) => {
      try {
        const keyNorm = key.trim();
        const valueNorm = value.trim();

        if (!keyNorm) {
          return {
            content: [{ type: 'text', text: 'Ключ не может быть пустым' }],
            isError: true,
          };
        }

        if (!valueNorm) {
          return {
            content: [{ type: 'text', text: 'Значение не может быть пустым' }],
            isError: true,
          };
        }

        run('INSERT OR REPLACE INTO config (key, value) VALUES (@key, @value)', {
          key: keyNorm,
          value: valueNorm,
        });

        const row = get('SELECT key, value FROM config WHERE key = ?', keyNorm);
        return {
          content: [{ type: 'text', text: JSON.stringify({ key: row.key, value: row.value }) }],
        };
      } catch (err) {
        console.error('[config_set]', err);
        return {
          content: [{ type: 'text', text: `Ошибка установки настройки: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
