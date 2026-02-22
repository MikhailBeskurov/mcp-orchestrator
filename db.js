// db.js — Инициализация и хелперы SQLite
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_PATH = join(DATA_DIR, 'orchestrator.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

/** Синглтон экземпляра БД */
let dbInstance = null;

/**
 * Получить экземпляр Database. При первом вызове создаёт директорию data,
 * открывает БД, применяет pragma и схему.
 * @returns {Database}
 */
export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`[db] Файл схемы не найден: ${SCHEMA_PATH}`);
  }

  const db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
  } catch (cause) {
    db.close();
    throw new Error('[db] Ошибка инициализации БД: не удалось применить схему', { cause });
  }

  dbInstance = db;
  return dbInstance;
}

/**
 * Создать prepared statement для повторного использования (кэширование в tool-модулях)
 * @param {string} sql
 * @returns {import('better-sqlite3').Statement}
 */
export function prepare(sql) {
  return getDb().prepare(sql);
}

/**
 * Выполнить функцию в транзакции (атомарно)
 * @param {() => unknown} fn — функция, возвращающая результат транзакции
 * @returns {unknown}
 */
export function transaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * Выполнить SQL без возврата результата
 * @param {string} sql
 * @param {...unknown} params
 * @returns {Database.RunResult}
 */
export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

/**
 * Выполнить SQL и вернуть одну строку
 * @param {string} sql
 * @param {...unknown} params
 * @returns {object|undefined}
 */
export function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

/**
 * Выполнить SQL и вернуть все строки
 * @param {string} sql
 * @param {...unknown} params
 * @returns {object[]}
 */
export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

/**
 * Закрыть БД и обнулить синглтон
 */
export function close() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
