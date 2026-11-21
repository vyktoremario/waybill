import { Pool } from 'pg';

/**
 * Starts the api for Hookstorm (F4): its own database (waybill_hookstorm), port 4200, and the test-only
 * /hookstorm routes. It never touches the demo or dev database.
 */
const BASE = process.env.DATABASE_URL ?? 'postgres://waybill:waybill@127.0.0.1:55432/waybill';
const URL = BASE.replace(/\/[^/]+$/, '/waybill_hookstorm');

async function main() {
  const admin = new Pool({ connectionString: BASE, max: 1 });
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'waybill_hookstorm'`);
  if (!exists.rowCount) await admin.query('CREATE DATABASE waybill_hookstorm');
  await admin.end();
  Object.assign(process.env, {
    DATABASE_URL: URL,
    PORT: '4200',
    HOOKSTORM_ROUTES: '1',
    PAYSTACK_SECRET_KEY: 'sk_test_waybill_local',
  });
  await (require('../main') as typeof import('../main')).main();
}

void main();
