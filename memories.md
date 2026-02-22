# Memories — MCP Orchestrator

## Текущая версия: 0.5 (Интеграция с Cursor) — ЗАВЕРШЕНА

### Реализовано (v0.1)
- `package.json` — ESM, зависимости: `@modelcontextprotocol/sdk ^1.26.0`, `better-sqlite3 ^11.0.0`, `zod ^3.24.0`
- `schema.sql` — 9 таблиц, 11 индексов, 3 дефолтных конфига (IF NOT EXISTS)
- `db.js` — синглтон SQLite, pragma (WAL, synchronous=NORMAL, FK, busy_timeout), хелперы: run/get/all/prepare/transaction/close
- `index.js` — MCP-сервер (stdio), автозагрузка tools/*.js, graceful shutdown (server.close + db.close)

### Реализовано (v0.2)
- `tools/tasks.js` — task_create, task_list, task_update, task_get
  - Динамический WHERE через bind-параметры (безопасно от SQL injection)
  - parseTask — утилита парсинга задачи из БД (files, depends_on)
  - task_update: обновляет result ТОЛЬКО при явной передаче (не затирает существующее)
  - task_get: возвращает задачу + связанные reviews + messages

### Реализовано (v0.3)
- `utils.js` — parseJsonField вынесен из tasks.js в общий модуль (обрабатывает string, array, object, null)
- `tools/reviews.js` — review_submit, review_list, review_resolve
  - review_submit: валидация task_id, file/line_start/line_end связей, нормализация пустого file через trim
  - review_list: 6 фильтров (task_id, file, priority, status, reviewer, category) + LIMIT с дефолтом 100, max 1000
  - review_resolve: динамический UPDATE — resolve_comment включается в SET только при явной передаче
  - Константы: REVIEWER, PRIORITY, STATUS, RESOLVE_STATUS, CATEGORY
- `schema.sql` — добавлен индекс idx_reviews_created(created_at DESC)
- `tools/tasks.js` — parseJsonField заменён на импорт из utils.js

### Тестирование (настроено в v0.3)
- vitest v4.x в devDependencies, скрипты: `npm test`, `npm run test:watch`
- `vitest.config.js` — include: `tests/**/*.test.js`
- 67 тестов (v0.3): db(10), utils(12), tasks(21), reviews(24)
- Хелперы: `tests/helpers/mock-server.js`, `tests/helpers/parse-response.js`
- Мок db.js: `vi.hoisted()` + `vi.mock()` + in-memory SQLite (паттерн зафиксирован в `.cursor/rules/testing-patterns.mdc`)
- db.js тестируется на реальной БД с префиксом `__test_db_`

### Реализовано (v0.4)
- `tools/file_locks.js` — file_lock, file_unlock, file_locks_list
  - file_lock: атомарная блокировка через transaction() (защита от race condition), идемпотентность при повторной блокировке тем же агентом, обработка UNIQUE constraint
  - file_unlock: снятие блокировки только владельцем (DELETE)
  - file_locks_list: фильтры locked_by и task_id, динамический WHERE, ORDER BY locked_at DESC
  - Константа LOCKED_BY (executor_1, executor_2, reviewer_impl, reviewer_arch)
  - Нормализация file через trim(), проверка пустого пути после trim
  - Валидация task_id (проверка существования в tasks)
- `schema.sql` — добавлены индексы idx_file_locks_locked_by, idx_file_locks_task
- 85 тестов: db(10), utils(12), tasks(21), reviews(24), file_locks(18)

### Реализовано (v0.5)
- `.cursor/mcp.json` — конфигурация подключения MCP-сервера к Cursor (command: node, args: index.js, stdio-транспорт)
- Smoke-тест: 11/11 инструментов — полный цикл task→review→file_lock через MCP-протокол

### Следующая версия: 0.6 (Память проекта)
- `memory_store`, `memory_search`, `memory_delete`

### Архитектурные решения
- Синглтон БД устанавливается ТОЛЬКО после успешной инициализации (при ошибке — close + rethrow)
- Версия сервера читается из package.json через createRequire
- Tool-модули экспортируют register(server), автозагружаются из tools/
- parseJsonField — вынесен в utils.js (общий модуль утилит)
- Enum-константы (ASSIGNED_TO, PRIORITY, STATUS и т.д.) — пока в каждом модуле, при росте — в общий конфиг
- Опциональные поля в UPDATE: если параметр не передан — НЕ включать в SET (паттерн if/else ветвления)
