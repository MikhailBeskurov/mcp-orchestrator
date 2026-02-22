# Memories — MCP Orchestrator

## Текущая версия: 0.3 (Код-ревью) — ЗАВЕРШЕНА

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

### Следующая версия: 0.4 (Файловые блокировки)
- `tools/file_locks.js` — file_lock, file_unlock, file_locks_list

### Архитектурные решения
- Синглтон БД устанавливается ТОЛЬКО после успешной инициализации (при ошибке — close + rethrow)
- Версия сервера читается из package.json через createRequire
- Tool-модули экспортируют register(server), автозагружаются из tools/
- parseJsonField — вынесен в utils.js (общий модуль утилит)
- Enum-константы (ASSIGNED_TO, PRIORITY, STATUS и т.д.) — пока в каждом модуле, при росте — в общий конфиг
- Опциональные поля в UPDATE: если параметр не передан — НЕ включать в SET (паттерн if/else ветвления)
