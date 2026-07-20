#!/usr/bin/env node
// Engagement server entrypoint.
// Usage: node --experimental-sqlite bin/server.js [--config path] [--db path] [--port n]

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    db: { type: 'string' },
    port: { type: 'string' },
  },
});

const configPath = values.config
  ? resolve(values.config)
  : existsSync(join(pkgRoot, 'config.json'))
    ? join(pkgRoot, 'config.json')
    : null;
const config = loadConfig(configPath);

const dbPath = values.db ?? process.env.DB_PATH ?? join(pkgRoot, 'data', 'engagement.db');
const store = createStore({ path: dbPath });

const port = Number(values.port ?? process.env.PORT ?? 3000);
const server = createApp({ store, config });

server.listen(port, () => {
  console.log(`[engagement] listening on http://localhost:${port}`);
  console.log(`[engagement] config: ${configPath ?? '(none — zero teams)'}  teams: ${config.teams.length}`);
  console.log(`[engagement] storage: ${store.backend} @ ${dbPath}`);
  console.log(`[engagement] dashboard: http://localhost:${port}/`);
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    console.log('[engagement] GitHub webhook HMAC verification: ON');
  }
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
