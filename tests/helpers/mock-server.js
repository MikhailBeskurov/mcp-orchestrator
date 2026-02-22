/**
 * Мок MCP-сервера для тестирования tool-хендлеров.
 */
export function createMockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) {
      tools.set(name, handler);
    },
    async callTool(name, params) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Инструмент "${name}" не зарегистрирован`);
      return tool(params);
    },
  };
}
