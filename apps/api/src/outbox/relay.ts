import { Client } from 'pg';
import type { Db } from '../db/db';
import type { Rabbit } from '../mq/rabbit';

/**
 * Outbox relay (ADR-0005): publish unpublished rows in id order with publisher confirms, then mark them.
 * A crash between publish and mark republishes the row; consumers handle duplicates.
 * Wakes on LISTEN/NOTIFY, with a slow safety poll.
 */
export class OutboxRelay {
  private stopped = false;
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private listener: Client | null = null;

  constructor(
    private readonly db: Db,
    private readonly rabbit: Rabbit,
    private readonly databaseUrl: string,
    private readonly opts: { pollMs?: number; batch?: number } = {},
  ) {}

  async start(): Promise<void> {
    this.listener = new Client({ connectionString: this.databaseUrl });
    this.listener.on('error', (err) => console.error('[relay] listen error', err.message));
    await this.listener.connect();
    this.listener.on('notification', () => this.wake?.());
    await this.listener.query('LISTEN outbox_new');
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
    await this.listener?.end().catch(() => undefined);
  }

  /** Publishes one batch. Returns how many rows went out. */
  async drainOnce(): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const rows = (
        await client.query(
          `SELECT id, message_id, type, payload, delay_ms FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [this.opts.batch ?? 100],
        )
      ).rows;
      const published: number[] = [];
      for (const r of rows) {
        try {
          await this.rabbit.publish(r.type, r.message_id, r.payload, r.delay_ms);
          published.push(Number(r.id));
        } catch (err: any) {
          console.error(`[relay] publish ${r.type} failed: ${err.message}`);
          await client.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = $1`, [r.id]);
          break; // keep order: stop at the first failure and retry later
        }
      }
      if (published.length) await client.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, [published]);
      await client.query('COMMIT');
      return published.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let n = 0;
      try {
        n = await this.drainOnce();
      } catch (err: any) {
        console.error(`[relay] ${err.message}`);
      }
      if (n > 0 || this.stopped) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs ?? 5_000);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}
