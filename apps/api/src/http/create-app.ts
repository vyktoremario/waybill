import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Core } from '../core';
import { AppModule } from './app';

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
