#!/usr/bin/env node
// index.js — Точка входа MCP Orchestrator
import { createRequire } from 'module';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, close } from './db.js';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, 'tools');

// Инициализация БД при старте
getDb();

const server = new McpServer({
  name: 'mcp-orchestrator',
  version: pkg.version,
});

// Автозагрузка инструментов из tools/
async function loadTools() {
  let files;
  try {
    files = readdirSync(TOOLS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('[mcp-orchestrator] Директория tools/ не найдена, инструменты не загружены');
      return;
    }
    throw err;
  }
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  for (const file of jsFiles) {
    const modulePath = join(TOOLS_DIR, file);
    const moduleUrl = pathToFileURL(modulePath).href;
    const mod = await import(moduleUrl);
    if (typeof mod.register === 'function') {
      mod.register(server);
    }
  }
}

await loadTools();

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
async function shutdown() {
  await server.close();
  close();
  process.exit(0);
}

function handleShutdown() {
  shutdown().catch((err) => {
    console.error('[mcp-orchestrator] Ошибка при завершении:', err);
    process.exit(1);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
