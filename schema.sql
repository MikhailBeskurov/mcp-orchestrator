-- schema.sql — Схема БД MCP Orchestrator
-- Безопасное повторное применение: CREATE TABLE IF NOT EXISTS

-- Сессии оркестрации
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal TEXT NOT NULL,
    plan TEXT,
    status TEXT DEFAULT 'active',  -- active / completed / abandoned
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Задачи
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    title TEXT NOT NULL,
    description TEXT,
    assigned_to TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',  -- low / normal / high / critical
    status TEXT DEFAULT 'pending',   -- pending / in_progress / done / failed
    result TEXT,
    files TEXT,        -- JSON array
    depends_on TEXT,   -- JSON array of task IDs
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Замечания ревью
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id),
    reviewer TEXT NOT NULL,
    file TEXT,
    line_start INTEGER,
    line_end INTEGER,
    priority TEXT DEFAULT 'normal',  -- normal / high / critical
    category TEXT,     -- bug / performance / architecture / hardcode / modding / style / missing_feature
    description TEXT NOT NULL,
    suggestion TEXT,
    status TEXT DEFAULT 'open',  -- open / fixed / wontfix
    resolve_comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Файловые блокировки
CREATE TABLE IF NOT EXISTS file_locks (
    file TEXT PRIMARY KEY,
    locked_by TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    locked_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Межагентные сообщения
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    type TEXT DEFAULT 'info',  -- info / question / blocker / done
    content TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- База знаний (память проекта)
CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,  -- architecture / bug / decision / convention / pattern / performance / gotcha
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,            -- JSON array
    related_files TEXT,   -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Лог событий сессии
CREATE TABLE IF NOT EXISTS session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Результаты сборок
CREATE TABLE IF NOT EXISTS builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id),
    success INTEGER NOT NULL,
    errors TEXT,          -- JSON array
    warnings TEXT,        -- JSON array
    related_tasks TEXT,   -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Конфигурация
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Индексы для часто используемых полей
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
CREATE INDEX IF NOT EXISTS idx_session_log_session ON session_log(session_id);
CREATE INDEX IF NOT EXISTS idx_builds_session ON builds(session_id);

-- Дефолтные значения конфигурации
INSERT OR IGNORE INTO config (key, value) VALUES ('max_review_iterations', '3');
INSERT OR IGNORE INTO config (key, value) VALUES ('auto_lock_files', 'true');
INSERT OR IGNORE INTO config (key, value) VALUES ('review_priorities_enforce', 'true');
