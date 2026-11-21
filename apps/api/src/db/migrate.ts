import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../config';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Applies pending SQL migrations in order. `reset` drops everything first (tests and demos only). */
export async function migrate(databaseUrl: string, opts: { reset?: boolean; quiet?: boolean } = {}): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (opts.reset) {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // One migrator at a time (several processes may start together).
    await pool.query('SELECT pg_advisory_lock(727274)');
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await pool.query('COMMIT');
        if (!opts.quiet) console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    }
    await pool.query('SELECT pg_advisory_unlock(727274)');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  migrate(loadConfig().databaseUrl, { reset: process.argv.includes('--reset') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
