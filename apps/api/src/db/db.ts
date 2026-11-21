import { Pool, type PoolClient } from 'pg';

export type Db = Pool;
export type Tx = PoolClient;

export function createPool(url: string): Pool {
  const pool = new Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // An idle client erroring (e.g. Postgres restarted) must not crash the process.
  pool.on('error', (err) => console.error('[pg] idle client error', err.message));
  return pool;
}

/** Runs fn in one transaction. Retries serialization failures and deadlocks a few times. */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      const retryable = err?.code === '40001' || err?.code === '40P01';
      if (retryable && attempt < 4) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** WKT point for a geography column. Note the lng/lat order. */
export function point(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}
