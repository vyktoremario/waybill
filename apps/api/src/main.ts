import 'reflect-metadata';
import { loadConfig } from './config';
import { createCore } from './core';
import { migrate } from './db/migrate';
import { createApp } from './http/create-app';

// The entry file exports nothing and starts on load: Vercel's NestJS support loads it and hooks app.listen(),
// the same way it runs any NestJS app. Locally and in Docker it simply listens on PORT.
async function main() {
  const config = loadConfig();
  if (process.env.MIGRATE_ON_START !== '0') await migrate(config.databaseUrl, { quiet: true });
  const core = createCore(config);
  const app = await createApp(core);
  await app.listen(config.port, '0.0.0.0');
  console.log(`[api] listening on :${config.port}`);
}

main().catch((err) => {
  console.error('[api] fatal', err);
  process.exit(1);
});
