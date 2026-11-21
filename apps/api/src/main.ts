import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from './config';
import { createCore, type Core } from './core';
import { migrate } from './db/migrate';
import { AppModule } from './http/app';

export async function createApp(core: Core): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forCore(core), {
    rawBody: true, // the Paystack signature is over the raw bytes
    logger: ['error', 'warn'],
  });
  app.useBodyParser('raw', { type: ['image/jpeg', 'image/png', 'image/webp'], limit: '4mb' });
  app.enableCors({ origin: true, credentials: false });
  app.enableShutdownHooks();
  return app;
}

async function main() {
  const config = loadConfig();
  if (process.env.MIGRATE_ON_START !== '0') await migrate(config.databaseUrl, { quiet: true });
  const core = createCore(config);
  const app = await createApp(core);
  await app.listen(config.port, '0.0.0.0');
  console.log(`[api] listening on :${config.port}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[api] fatal', err);
    process.exit(1);
  });
}
