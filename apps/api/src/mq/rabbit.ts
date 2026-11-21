import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import type { Db } from '../db/db';
import { DomainError } from '../errors';

export const EVENTS_EXCHANGE = 'events';
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface ConsumerSpec {
  name: string; // queue name, also the processed_messages consumer id
  bindings: string[]; // routing-key patterns on the events exchange
  handle: (type: string, payload: any) => Promise<void>;
}

/**
 * RabbitMQ topology (ADR-0005):
 * - `events` topic exchange, one durable queue per consumer;
 * - retries: `<queue>.retry.<n>` with a TTL, dead-lettered straight back to `<queue>`; then `<queue>.dlq`;
 * - delays: a fanout exchange + queue per duration, dead-lettered into `events` with the routing key kept.
 */
export class Rabbit {
  private conn!: ChannelModel;
  ch!: ConfirmChannel;
  private readonly delayQueues = new Set<number>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    this.conn = await amqp.connect(this.url);
    this.conn.on('error', (err) => console.error('[amqp] connection error', err.message));
    this.ch = await this.conn.createConfirmChannel();
    await this.ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  }

  onClose(fn: () => void): void {
    this.conn.on('close', fn);
  }

  async close(): Promise<void> {
    await this.ch?.close().catch(() => undefined);
    await this.conn?.close().catch(() => undefined);
  }

  private async ensureDelay(ms: number): Promise<string> {
    const name = `delay.${ms}ms`;
    if (!this.delayQueues.has(ms)) {
      await this.ch.assertExchange(name, 'fanout', { durable: true });
      await this.ch.assertQueue(name, { durable: true, arguments: { 'x-message-ttl': ms, 'x-dead-letter-exchange': EVENTS_EXCHANGE } });
      await this.ch.bindQueue(name, name, '');
      this.delayQueues.add(ms);
    }
    return name;
  }

  /** Publishes and waits for the broker's confirm, so the caller only marks the outbox row once it's safe. */
  async publish(type: string, messageId: string, payload: unknown, delayMs = 0): Promise<void> {
    const exchange = delayMs > 0 ? await this.ensureDelay(delayMs) : EVENTS_EXCHANGE;
    const body = Buffer.from(JSON.stringify(payload));
    await new Promise<void>((resolve, reject) => {
      this.ch.publish(exchange, type, body, { persistent: true, messageId, type, contentType: 'application/json' }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async consume(db: Db, spec: ConsumerSpec, opts: { prefetch?: number } = {}): Promise<void> {
    const ch = this.ch;
    const q = spec.name;
    await ch.assertQueue(`${q}.dlq`, { durable: true });
    await ch.assertQueue(q, { durable: true });
    for (const key of spec.bindings) await ch.bindQueue(q, EVENTS_EXCHANGE, key);
    for (const [i, ms] of RETRY_DELAYS_MS.entries()) {
      await ch.assertQueue(`${q}.retry.${i + 1}`, {
        durable: true,
        arguments: { 'x-message-ttl': ms, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': q },
      });
    }
    await ch.prefetch(opts.prefetch ?? 10);

    await ch.consume(q, async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      const messageId = String(msg.properties.messageId ?? '');
      const type = String(msg.properties.type ?? msg.fields.routingKey);
      const attempt = Number(msg.properties.headers?.['x-attempt'] ?? 1);
      try {
        if (!messageId) throw new Error('message has no messageId');
        const payload = JSON.parse(msg.content.toString('utf8'));
        // Skip messages this consumer already finished. The record is written only AFTER the handler
        // succeeds: claiming first would lose the work if the process died mid-handler (F1). Handlers are
        // therefore written to be safe to run twice (they re-check state under row locks); this table just
        // saves the repeated work and lets the invariant checker prove each message was handled once.
        const done = await db.query(`SELECT 1 FROM processed_messages WHERE consumer = $1 AND message_id = $2`, [q, messageId]);
        if (done.rowCount) {
          ch.ack(msg);
          return;
        }
        await spec.handle(type, payload);
        await db.query(`INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [q, messageId]);
        ch.ack(msg);
      } catch (err: any) {
        const permanent = err instanceof DomainError && err.code !== 'conflict';
        const target = permanent || attempt >= MAX_ATTEMPTS ? `${q}.dlq` : `${q}.retry.${attempt}`;
        console.error(`[amqp] ${q} ${type} ${messageId} attempt ${attempt} failed: ${err?.message}; → ${target}`);
        try {
          await new Promise<void>((resolve, reject) =>
            ch.sendToQueue(
              target,
              msg.content,
              { ...msg.properties, headers: { ...msg.properties.headers, 'x-attempt': attempt + 1, 'x-last-error': String(err?.message ?? err).slice(0, 500) } },
              (e) => (e ? reject(e) : resolve()),
            ),
          );
          ch.ack(msg);
        } catch {
          ch.nack(msg, false, true);
        }
      }
    });
  }

  /** Queue depths for the dashboard's health strip. */
  async depth(queue: string): Promise<number> {
    try {
      const ch = await this.conn.createChannel();
      const r = await ch.checkQueue(queue);
      await ch.close();
      return r.messageCount;
    } catch {
      return -1;
    }
  }
}
