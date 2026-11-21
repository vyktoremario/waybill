import type { RealtimeMessage } from '@waybill/shared';
import Redis from 'ioredis';

/** Rooms map 1:1 to Redis channels `rt:<room>` (ADR-0003). */
export interface RealtimePublisher {
  publish(room: string, msg: RealtimeMessage): Promise<void>;
  /** Small shared key/value for health numbers. */
  setKey(key: string, value: string, ttlSeconds: number): Promise<void>;
  getKey(key: string): Promise<string | null>;
  close(): Promise<void>;
}

export class RedisPublisher implements RealtimePublisher {
  private readonly redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.redis.on('error', (err) => console.error('[redis] publisher', err.message));
  }
  async publish(room: string, msg: RealtimeMessage): Promise<void> {
    try {
      await this.redis.publish(`rt:${room}`, JSON.stringify(msg));
    } catch (err: any) {
      // Live updates are best-effort: clients resync from REST on reconnect.
      console.error(`[redis] publish ${room} failed: ${err.message}`);
    }
  }
  async setKey(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds).catch(() => undefined);
  }
  async getKey(key: string): Promise<string | null> {
    return this.redis.get(key).catch(() => null);
  }
  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

export class NullPublisher implements RealtimePublisher {
  readonly sent: Array<{ room: string; msg: RealtimeMessage }> = [];
  async publish(room: string, msg: RealtimeMessage): Promise<void> {
    this.sent.push({ room, msg });
  }
  private readonly kv = new Map<string, string>();
  async setKey(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
  async getKey(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async close(): Promise<void> {}
}
