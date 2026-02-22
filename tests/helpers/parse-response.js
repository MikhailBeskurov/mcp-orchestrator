/**
 * Парсит JSON из MCP-ответа tool-хендлера.
 */
export function parseResponse(res) {
  const text = res.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
