# Memories — MCP Orchestrator

## Текущая версия: 1.0 (Конфигурация) — ЗАВЕРШЕНА

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

### Развёртывание (настроено в v0.5)
- **project-rbfx** (`C:\project-rbfx`) — первый внешний потребитель MCP-сервера
- Паттерн подключения внешнего проекта:
  - `.cursor/mcp.json` с **абсолютным** путём: `["C:\\mcp-orchestrator\\index.js"]`
  - `.cursor/rules/mcp-orchestrator.mdc` — правило обязательного использования MCP-инструментов
  - Обновление существующего правила оркестрации — workflow ссылается на MCP-инструменты
- Self-hosting (mcp-orchestrator сам): относительный путь `["index.js"]` в `.cursor/mcp.json`

### Реализовано (v0.6)
- `tools/memory.js` — memory_store, memory_search, memory_delete
  - memory_store: INSERT с trim(title, content), JSON.stringify для tags/related_files
  - memory_search: LIKE по title/content/tags с экранированием спецсимволов (%, _) через ESCAPE, фильтр по category, лимит (DEFAULT_SEARCH_LIMIT=50, max 500)
  - memory_delete: проверка существования + DELETE
  - parseMemoryRow — утилита парсинга tags/related_files через parseJsonField
  - Константы: CATEGORY (7 значений), DEFAULT_SEARCH_LIMIT
- 105 тестов: db(10), utils(12), tasks(21), reviews(24), file_locks(18), memory(20)

### Реализовано (v0.7)
- `tools/sessions.js` — session_start, session_log, session_history
  - session_start: INSERT с trim(goal, plan), пустой plan после trim → null, статус по умолчанию 'active'
  - session_log: валидация session_id (FK), trim content, проверка пустого content после trim → isError
  - session_history: два режима — конкретная сессия с массивом logs (ORDER BY created_at ASC) или список сессий с фильтром по status (ORDER BY created_at DESC, LIMIT)
  - Константы: SESSION_STATUS (3), EVENT_TYPE (12), DEFAULT_HISTORY_LIMIT=50
- 130 тестов: db(10), utils(12), tasks(21), reviews(24), file_locks(18), memory(20), sessions(25)

### Реализовано (v0.8)
- `tools/messages.js` — message_send, message_read
  - message_send: from_agent/to_agent (enum AGENT с orchestrator), task_id (optional, FK валидация), type (enum: info/question/blocker/done, default 'info'), content (trim, проверка пустоты)
  - message_read: role (to_agent фильтр), task_id (optional), unread_only (boolean, default true), limit (max MAX_READ_LIMIT=500, default DEFAULT_READ_LIMIT=50)
  - Атомарный read+mark через transaction: SELECT → UPDATE SET read=1 WHERE id IN (...)
  - Позиционные плейсхолдеры ? для динамического IN (ids из SELECT безопасны)
  - Константы: AGENT (5 ролей включая orchestrator), MESSAGE_TYPE, DEFAULT_READ_LIMIT, MAX_READ_LIMIT
- 154 теста: db(10), utils(12), tasks(21), reviews(24), file_locks(18), memory(20), sessions(25), messages(24)

### Реализовано (v0.8.5)
- `tools/tasks.js` — orchestrator добавлен в ASSIGNED_TO enum; task_create возвращает полный объект + locked_files; автоблокировка файлов в транзакции (N+1 оптимизирован → один SELECT WHERE IN); task_update: атомарная разблокировка при done/failed (через transaction)
- `tools/file_locks.js` — orchestrator добавлен в LOCKED_BY enum
- `tools/reviews.js` — review_submit возвращает полный объект (SELECT * после INSERT)
- `tools/sessions.js` — session_update (completed/abandoned): автоочистка в транзакции (разблокировка файлов + fail pending/in_progress задач), разные result-тексты; SESSION_UPDATE_STATUS константа; session_start: orphaned cleanup перед созданием сессии (abandoned-сессии + бесхозные блокировки), cleanup в ответе при наличии очищенных записей
- 184 теста: db(10), utils(12), tasks(31), reviews(25), file_locks(20), memory(20), sessions(42), messages(24)

### Реализовано (v0.9)
- `tools/builds.js` — build_log, build_history
  - build_log: запись результата сборки (success boolean→INTEGER, errors/warnings/related_tasks JSON arrays), валидация session_id FK, полный объект в ответе через parseBuildRow
  - build_history: фильтр по session_id, валидация FK, динамический WHERE через conditions+params, ORDER BY created_at DESC, LIMIT
  - parseBuildRow — утилита: success→boolean, errors/warnings/related_tasks через parseJsonField
  - Константы: DEFAULT_HISTORY_LIMIT=50, MAX_HISTORY_LIMIT=500
- 207 тестов: db(10), utils(12), tasks(31), reviews(25), file_locks(20), memory(20), sessions(42), messages(24), builds(23)

### Реализовано (v0.9.5)
- `tools/tasks.js` — task_create: опциональный параметр `status` (enum STATUS_CREATE = ['pending', 'in_progress'], default 'pending'); добавлен в INSERT; константа STATUS_CREATE
- `tools/reviews.js` — review_submit_batch: батч-отправка замечаний (массив, атомарная транзакция, валидация через validateReviewItem, SELECT WHERE IN вместо N+1); review_resolve_batch: батч-закрытие замечаний (валидация через SELECT WHERE IN, UPDATE в транзакции, SELECT WHERE IN для результата)
- `tools/reviews.js` — validateReviewItem: общая функция валидации замечания (task_id, file/line_start/line_end, line_end >= line_start)
- `.cursor/rules/orchestration.mdc` — обновлено: секция «Автоматизация (v0.9.5)», батч-инструменты в MCP-списке, шаги 3-6 (task_create status, review_submit_batch, review_resolve_batch, session_update)
- 224 теста: db(10), utils(12), tasks(35), reviews(38), file_locks(20), memory(20), sessions(42), messages(24), builds(23)

### Реализовано (v1.0)
- `tools/config.js` — config_get, config_set
  - config_get: key (optional) — если передан, возвращает {key, value}; если нет — массив всех настроек [{key, value}, ...]; trim(key), проверка пустоты, проверка существования ключа
  - config_set: INSERT OR REPLACE, trim(key/value), проверка пустоты, SELECT после INSERT для полного ответа
  - Защита от null: `key != null` (нестрогое сравнение, покрывает undefined и null)
- Дефолтные значения уже в schema.sql (INSERT OR IGNORE): max_review_iterations=3, auto_lock_files=true, review_priorities_enforce=true
- `.cursor/rules/orchestration.mdc` — добавлена секция «Конфигурация» в MCP-инструменты
- 240 тестов: db(10), utils(12), tasks(35), reviews(38), file_locks(20), memory(20), sessions(42), messages(24), builds(23), config(16)

### Архитектурные решения
- Синглтон БД устанавливается ТОЛЬКО после успешной инициализации (при ошибке — close + rethrow)
- Версия сервера читается из package.json через createRequire
- Tool-модули экспортируют register(server), автозагружаются из tools/
- parseJsonField — вынесен в utils.js (общий модуль утилит)
- Enum-константы (ASSIGNED_TO, PRIORITY, STATUS и т.д.) — пока в каждом модуле, при росте — в общий конфиг
- Опциональные поля в UPDATE: если параметр не передан — НЕ включать в SET (паттерн if/else ветвления)
