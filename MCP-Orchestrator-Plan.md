# MCP Orchestrator — План автоматизации Cursor

## Что такое MCP

**MCP (Model Context Protocol)** — протокол, встроенный в Cursor, который позволяет подключать **внешние инструменты** к AI-ассистенту. MCP-сервер — это обычная программа на вашем компьютере (Node.js/Python), которая предоставляет AI новые команды.

**Ключевое:** MCP-сервер **не является ИИ**. Это обычный код (if/else, чтение/запись файлов, работа с БД). Все токены тратятся через подписку Cursor — дополнительных подписок не требуется.

```
┌─────────────────────────────────────────────────┐
│  Cursor (подписка пользователя)                 │
│                                                 │
│  AI (Оркестратор) ←── встроенные инструменты:   │
│    ├── Read, Write, Shell, Task ...             │
│    │                                            │
│    └── 🔌 MCP-инструменты (от нашего сервера)   │
│         ├── task_create()                       │
│         ├── review_submit()                     │
│         ├── memory_store()                      │
│         └── ... (см. ниже)                      │
└────────────────┬────────────────────────────────┘
                 │ localhost (локально)
                 ▼
┌─────────────────────────────────────────────────┐
│  MCP Orchestrator Server                        │
│  ├── Node.js + SQLite                           │
│  ├── Работает локально, без интернета           │
│  ├── Без API-ключей, без подписок               │
│  └── Хранит состояние на диске                  │
└─────────────────────────────────────────────────┘
```

---

## Проблемы, которые решаем

| Проблема | Сейчас | С MCP |
|----------|--------|-------|
| Субагенты не знают о работе друг друга | Оркестратор копирует контекст текстом, теряя детали | Общая шина данных — каждый агент читает/пишет напрямую |
| Потеря контекста между сессиями | Каждый раз начинаем с нуля | Персистентное хранилище (SQLite) |
| Конфликты при параллельном редактировании | Два агента правят один файл → конфликт | Файловые блокировки с владельцем |
| Замечания ревью теряются | Пересказ текстом, неструктурированно | Структурированная БД замечаний |
| Нет памяти о проекте | `memories.md` — примитивный текстовый файл | Полноценная база знаний с категориями и поиском |
| Нет истории сборок | Ошибки сборки забываются | Лог сборок с привязкой к задачам |
| Непрозрачный прогресс | Пользователь не видит, что происходит | Трекер задач с реальным статусом |

---

## Инструменты MCP-сервера

### Группа 1 — Управление задачами

Ядро оркестрации. Позволяет создавать, назначать и отслеживать задачи между агентами.

#### `task_create`
Создать задачу и назначить агенту.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `title` | string | Краткое название задачи |
| `description` | string | Подробное описание с требованиями |
| `assigned_to` | string | Роль агента: `executor_1`, `executor_2`, `reviewer_impl`, `reviewer_arch` |
| `priority` | string | `low` / `normal` / `high` / `critical` |
| `files` | string[] | Список файлов, закреплённых за задачей |
| `depends_on` | number[] | ID задач, от которых зависит эта |

**Возвращает:** `{ id: number, status: "pending" }`

**Пример:**
```json
{
  "title": "Реализовать PropScatterer::UpdateVisibleChunks",
  "description": "Метод должен определять видимые чанки на основе позиции камеры...",
  "assigned_to": "executor_1",
  "priority": "high",
  "files": ["Source/World/Vegetation/PropScatterer.cpp", "Source/World/Vegetation/PropScatterer.h"]
}
```

---

#### `task_list`
Получить список задач с фильтрацией.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `status` | string? | Фильтр: `pending` / `in_progress` / `done` / `failed` |
| `assigned_to` | string? | Фильтр по агенту |
| `session_id` | number? | Фильтр по сессии |

**Возвращает:** Массив задач с полями: id, title, status, assigned_to, priority, created_at, updated_at.

---

#### `task_update`
Обновить статус задачи.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `id` | number | ID задачи |
| `status` | string | Новый статус: `in_progress` / `done` / `failed` |
| `result` | string? | Описание результата или причина провала |

---

#### `task_get`
Получить полную информацию о задаче включая связанные ревью и сообщения.

**Параметры:** `{ id: number }`

**Возвращает:** Полный объект задачи + массив связанных ревью + сообщения.

---

### Группа 2 — Код-ревью и замечания

Структурированная система замечаний. Заменяет передачу замечаний текстом.

#### `review_submit`
Ревьюер отправляет замечание.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `task_id` | number | К какой задаче относится |
| `reviewer` | string | `reviewer_impl` / `reviewer_arch` |
| `file` | string | Путь к файлу |
| `line_start` | number? | Начальная строка (если конкретное место) |
| `line_end` | number? | Конечная строка |
| `priority` | string | `normal` / `high` / `critical` |
| `category` | string | `bug` / `performance` / `architecture` / `hardcode` / `modding` / `style` / `missing_feature` |
| `description` | string | Описание проблемы |
| `suggestion` | string? | Предложенное исправление |

**Пример:**
```json
{
  "task_id": 1,
  "reviewer": "reviewer_impl",
  "file": "Source/World/Vegetation/PropScatterer.cpp",
  "line_start": 142,
  "priority": "critical",
  "category": "performance",
  "description": "Аллокация std::vector внутри hot-loop. При 10k объектов = 10k аллокаций за кадр.",
  "suggestion": "Вынести вектор как член класса и использовать clear() + reserve()."
}
```

---

#### `review_list`
Получить замечания с фильтрацией.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `task_id` | number? | Фильтр по задаче |
| `file` | string? | Фильтр по файлу |
| `priority` | string? | Фильтр по приоритету |
| `status` | string? | `open` / `fixed` / `wontfix` |

---

#### `review_resolve`
Исполнитель помечает замечание как решённое.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `id` | number | ID замечания |
| `status` | string | `fixed` / `wontfix` |
| `comment` | string | Что было сделано или почему wontfix |

---

### Группа 3 — Файловые блокировки

Защита от конфликтов при параллельной работе нескольких агентов.

#### `file_lock`
Заблокировать файл за агентом. Другие агенты увидят, что файл занят.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `file` | string | Путь к файлу |
| `locked_by` | string | Кто блокирует: `executor_1` / `executor_2` |
| `task_id` | number? | В рамках какой задачи |

**Поведение:** Если файл уже заблокирован другим агентом — возвращает ошибку с информацией о владельце.

---

#### `file_unlock`
Снять блокировку.

**Параметры:** `{ file: string, locked_by: string }`

---

#### `file_locks_list`
Получить список всех текущих блокировок.

**Возвращает:** Массив `{ file, locked_by, task_id, locked_at }`.

---

### Группа 4 — Межагентная коммуникация

Асинхронный обмен сообщениями между агентами.

#### `message_send`
Отправить сообщение другому агенту или оркестратору.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `from` | string | Отправитель |
| `to` | string | Получатель: `orchestrator` / `executor_1` / `executor_2` / `reviewer_impl` / `reviewer_arch` |
| `task_id` | number? | Контекст задачи |
| `type` | string | `info` / `question` / `blocker` / `done` |
| `content` | string | Текст сообщения |

**Пример использования:** Агент 1 обнаружил, что ему нужно изменить файл, закреплённый за Агентом 2:
```json
{
  "from": "executor_1",
  "to": "orchestrator",
  "type": "blocker",
  "content": "Для задачи #3 мне необходимо изменить WorldManager.h, но он закреплён за executor_2. Нужно добавить forward declaration PropScatterer."
}
```

---

#### `message_read`
Прочитать сообщения для текущей роли.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `to` | string | Роль получателя |
| `unread_only` | boolean? | Только непрочитанные (default: true) |
| `task_id` | number? | Только по конкретной задаче |

---

### Группа 5 — Память проекта (Knowledge Base)

Полноценная замена `memories.md`. Структурированная база знаний о проекте с категориями и поиском.

#### `memory_store`
Сохранить факт, решение или контекст о проекте.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `category` | string | `architecture` / `bug` / `decision` / `convention` / `pattern` / `performance` / `gotcha` |
| `title` | string | Краткий заголовок |
| `content` | string | Подробное описание |
| `tags` | string[] | Теги для поиска |
| `related_files` | string[] | Связанные файлы |

**Пример:**
```json
{
  "category": "decision",
  "title": "PropScatterer использует чанковую систему",
  "content": "Мир разбит на чанки 64x64. PropScatterer генерирует пропы для видимых чанков. Seed генерации = хеш координат чанка + глобальный seed мира. Это обеспечивает детерминированность без хранения всех пропов.",
  "tags": ["prop-scatterer", "chunks", "world-gen"],
  "related_files": ["Source/World/Vegetation/PropScatterer.cpp"]
}
```

---

#### `memory_search`
Поиск по базе знаний.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `query` | string | Поисковый запрос (по title, content, tags) |
| `category` | string? | Фильтр по категории |
| `tags` | string[]? | Фильтр по тегам |

**Возвращает:** Массив записей, отсортированных по релевантности.

---

#### `memory_delete`
Удалить устаревшую запись.

**Параметры:** `{ id: number }`

---

### Группа 6 — Сессии и история

Отслеживание рабочих сессий. Позволяет продолжить работу с того места, где остановились.

#### `session_start`
Начать новую рабочую сессию.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `goal` | string | Цель сессии (что просил пользователь) |
| `plan` | string | Общий план выполнения |

**Возвращает:** `{ session_id: number }`

---

#### `session_log`
Записать событие в лог текущей сессии.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `session_id` | number | ID сессии |
| `event_type` | string | `task_started` / `task_done` / `build_success` / `build_failed` / `review_round` / `user_input` / `note` |
| `content` | string | Описание события |

---

#### `session_history`
Получить историю сессий или конкретную сессию с логом.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `session_id` | number? | Конкретная сессия (или все последние) |
| `limit` | number? | Сколько сессий вернуть (default: 10) |

---

### Группа 7 — Мониторинг сборок

Логирование результатов сборок с привязкой к задачам.

#### `build_log`
Записать результат сборки.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `session_id` | number | ID сессии |
| `success` | boolean | Успех или провал |
| `errors` | string[]? | Ошибки компиляции |
| `warnings` | string[]? | Предупреждения |
| `related_tasks` | number[]? | Связанные задачи |

---

#### `build_history`
Получить историю сборок.

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `session_id` | number? | Фильтр по сессии |
| `limit` | number? | Сколько записей (default: 10) |

---

### Группа 8 — Конфигурация

Настройки оркестратора, хранящиеся в БД.

#### `config_get`
Получить настройку.

**Параметры:** `{ key: string }`

**Доступные ключи:**
- `max_review_iterations` — максимум итераций ревью (default: 3)
- `auto_lock_files` — автоматически блокировать файлы при создании задачи (default: true)
- `review_priorities_enforce` — обязательно ли исполнять все critical/high замечания (default: true)

---

#### `config_set`
Установить настройку.

**Параметры:** `{ key: string, value: string }`

---

## Схема базы данных (SQLite)

```sql
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal TEXT NOT NULL,
    plan TEXT,
    status TEXT DEFAULT 'active', -- active / completed / abandoned
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    title TEXT NOT NULL,
    description TEXT,
    assigned_to TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'pending', -- pending / in_progress / done / failed
    result TEXT,
    files TEXT, -- JSON array
    depends_on TEXT, -- JSON array of task IDs
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id),
    reviewer TEXT NOT NULL,
    file TEXT,
    line_start INTEGER,
    line_end INTEGER,
    priority TEXT DEFAULT 'normal',
    category TEXT,
    description TEXT NOT NULL,
    suggestion TEXT,
    status TEXT DEFAULT 'open', -- open / fixed / wontfix
    resolve_comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE file_locks (
    file TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    locked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    type TEXT DEFAULT 'info',
    content TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT, -- JSON array
    related_files TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    success INTEGER NOT NULL,
    errors TEXT, -- JSON array
    warnings TEXT, -- JSON array
    related_tasks TEXT, -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

## Расположение MCP-сервера

MCP-оркестратор — это **персональный инструмент разработки**, а не часть игрового проекта. Поэтому он живёт **вне проекта**, рядом с другими конфигами Cursor.

### Почему вне проекта?

| Внутри проекта | Вне проекта |
|---|---|
| Засоряет игровой репозиторий | Репозиторий остаётся чистым |
| Попадает в git (нужен .gitignore) | Не мешает VCS |
| Привязан к одному проекту | Переиспользуется между ВСЕМИ проектами |
| Node.js зависимости рядом с C++ кодом | Чёткое разделение: игра ≠ тулинг |

### Структура файлов

**MCP-сервер** (`C:\Users\sergo\.cursor\mcp-orchestrator\`):
```
C:\Users\sergo\.cursor\mcp-orchestrator\
├── index.js              — Точка входа MCP-сервера
├── db.js                 — Инициализация и хелперы SQLite
├── tools/
│   ├── tasks.js          — Группа 1: Управление задачами
│   ├── reviews.js        — Группа 2: Код-ревью
│   ├── file-locks.js     — Группа 3: Файловые блокировки
│   ├── messages.js       — Группа 4: Межагентная коммуникация
│   ├── memory.js         — Группа 5: Память проекта
│   ├── sessions.js       — Группа 6: Сессии
│   ├── monitoring.js     — Группа 7: Мониторинг сборок
│   └── config.js         — Группа 8: Конфигурация
├── schema.sql            — Схема БД
├── package.json          — Зависимости (только @modelcontextprotocol/sdk + better-sqlite3)
└── data/
    └── orchestrator.db   — Файл БД (создаётся автоматически, хранит память, задачи, ревью)
```

**В каждом проекте** — только один файл-ссылка (`.cursor/mcp.json`):
```
c:\project-rbfx\
└── .cursor/
    └── mcp.json          — Указывает Cursor, где искать MCP-сервер
```

### Подключение к Cursor

Файл `.cursor/mcp.json` в корне **каждого проекта**, где нужен оркестратор:
```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["C:\\Users\\sergo\\.cursor\\mcp-orchestrator\\index.js"]
    }
  }
}
```

> **Переиспользование:** Если завтра создаёте второй проект — достаточно скопировать этот `mcp.json`. MCP-сервер общий, БД общая, вся память и история доступны из любого проекта.

После создания/изменения `mcp.json` — перезапустить Cursor. MCP-инструменты появятся автоматически.

---

## Этапы реализации

| Этап | Что делаем | Группы | Приоритет |
|------|-----------|--------|-----------|
| **1** | Ядро оркестрации | Задачи + Ревью + Блокировки (1-3) | Критичный — без этого нет смысла |
| **2** | Персистентность | Память + Сессии (5-6) | Высокий — сохраняем контекст между сессиями |
| **3** | Коммуникация | Сообщения + Мониторинг (4, 7) | Нормальный — полная координация |
| **4** | Тонкая настройка | Конфиги (8) | Низкий — удобство |

---

## Как это изменит рабочий процесс

### До (текущий подход):
```
Пользователь → Оркестратор → Task(Агент 1) → результат текстом →
→ Оркестратор пересказывает → Task(Агент 3 ревью) → замечания текстом →
→ Оркестратор пересказывает → Task(Агент 1 исправляет) → ...
```
Каждый пересказ теряет контекст. Оркестратор тратит своё контекстное окно.

### После (с MCP):
```
Пользователь → Оркестратор → session_start() → task_create() →
→ Task(Агент 1) → task_update(done) →
→ Task(Агент 3) → review_list() → review_submit() →
→ Task(Агент 1) → review_list() → исправляет → review_resolve() →
→ Task(Агент 3) → review_list(open) → "замечаний нет" → ГОТОВО
```
Агенты общаются через БД. Оркестратор только координирует, не пересказывает.
