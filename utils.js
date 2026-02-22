/**
 * Безопасный парсинг JSON-полей из БД.
 * @param {unknown} value — значение из БД
 * @returns {unknown} — распарсенный массив/объект или null
 */
export function parseJsonField(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) return value;
  return null;
}
