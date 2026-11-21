import { createHash, randomUUID } from 'node:crypto';
import { DEMO_DRIVERS, DEMO_PASSWORD } from '../db/seed';

/**
 * Simulated drivers for demos and the failure scripts. Each one logs in, goes online, sends location
 * batches, accepts offers and drives the delivery through the same API the Expo app uses.
 *
 *   tsx src/sim/drivers.ts [--count 3] [--speed 2] [--decline 0.2] [--offline-after-pickup 0]
 *
 * --offline-after-pickup N: after pickup, stop talking to the server for N seconds while still recording
 * locations and commands locally, then flush them (scenario F8).
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const COUNT = Number(args.get('count') ?? DEMO_DRIVERS.length);
const SPEED = Number(args.get('speed') ?? 1); // simulated metres per real second ×10
const DECLINE = Number(args.get('decline') ?? 0);
const OFFLINE_AFTER_PICKUP = Number(args.get('offline-after-pickup') ?? 0);

// A 1×1 PNG stands in for the pickup photo.
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SimDriver {
  token = '';
  seq = Date.now();
  pos: { lat: number; lng: number };
  offline = false;
  queue: Array<{ path: string; body: any }> = [];
  pointsBuffer: any[] = [];

  constructor(
    readonly name: string,
    readonly email: string,
    start: { lat: number; lng: number },
  ) {
    this.pos = { ...start };
  }

  log(msg: string) {
    console.log(`[${this.name.split(' ')[0]}] ${msg}`);
  }

  async req(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message ?? res.statusText), { status: res.status, body });
    return body;
  }

  async login() {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, password: DEMO_PASSWORD }) });
    if (!r.ok) throw new Error(`login failed for ${this.email}`);
    this.token = ((await r.json()) as any).token;
  }

  /** Commands go through a local queue, like the app's SQLite outbox: retried until the server answers. */
  async command(orderId: string, type: string, payload: Record<string, unknown> = {}, expectedVersion?: number): Promise<any> {
    const body = { commandId: randomUUID(), orderId, type, occurredAt: new Date().toISOString(), payload, expectedVersion };
    if (this.offline) {
      this.queue.push({ path: '/driver/commands', body });
      this.log(`offline: queued ${type} (${this.queue.length} waiting)`);
      return null;
    }
    return this.sendWithRetry('/driver/commands', body);
  }

  async sendWithRetry(path: string, body: any): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.req(path, { method: 'POST', body: JSON.stringify(body) });
      } catch (err: any) {
        if (err.status && err.status < 500) throw err; // a real answer (conflict, wrong PIN): don't retry
        await sleep(Math.min(10_000, 500 * 2 ** attempt));
      }
    }
  }

  async flush() {
    if (this.pointsBuffer.length) {
      await this.sendWithRetry('/driver/locations', { points: this.pointsBuffer.splice(0) });
    }
    while (this.queue.length) {
      const next = this.queue[0]!;
      try {
        const r: any = await this.sendWithRetry(next.path, next.body);
        this.log(`synced ${(next.body as any).type}${r?.replayed ? ' (already applied)' : ''}`);
      } catch (err: any) {
        this.log(`server rejected ${(next.body as any).type}: ${err.message}`);
        this.queue.length = 0; // conflict: drop this order's queued work and resync, never "win"
        return;
      }
      this.queue.shift();
    }
  }

  async sendLocation(orderId?: string) {
    const p = { seq: this.seq++, recordedAt: new Date().toISOString(), lat: this.pos.lat, lng: this.pos.lng, accuracy: 8, orderId };
    if (this.offline) {
      this.pointsBuffer.push(p);
      return;
    }
    await this.req('/driver/locations', { method: 'POST', body: JSON.stringify({ points: [p] }) }).catch(() => this.pointsBuffer.push(p));
  }

  async driveTo(target: { lat: number; lng: number }, orderId: string) {
    for (;;) {
      const dLat = target.lat - this.pos.lat;
      const dLng = target.lng - this.pos.lng;
      const dist = Math.hypot(dLat, dLng);
      const step = 0.0009 * SPEED; // ~100 m per tick at speed 1
      if (dist <= step) {
        this.pos = { ...target };
        await this.sendLocation(orderId);
        return;
      }
      this.pos = { lat: this.pos.lat + (dLat / dist) * step, lng: this.pos.lng + (dLng / dist) * step };
      await this.sendLocation(orderId);
      await sleep(1_000);
    }
  }

  async run() {
    await this.login();
    await this.req('/driver/availability', { method: 'POST', body: JSON.stringify({ status: 'available' }) }).catch((e) => this.log(e.message));
    this.log('online');
    for (;;) {
      await this.sendLocation();
      const cur = await this.req('/driver/current').catch(() => null);
      if (cur?.order) await this.deliver(cur.order);
      else if (cur?.offer) {
        const o = cur.offer.order;
        if (Math.random() < DECLINE) {
          this.log(`declining ${o.id.slice(-6)}`);
          await this.command(o.id, 'decline_offer').catch((e) => this.log(e.message));
        } else {
          this.log(`accepting ${o.id.slice(-6)} (${o.pickup_address} → ${o.dropoff_address})`);
          await this.command(o.id, 'accept_offer').catch((e) => this.log(`accept failed: ${e.message}`));
        }
      }
      await sleep(2_000);
    }
  }

  async deliver(order: any) {
    try {
      const id = order.id;
      if (order.status === 'ASSIGNED') await this.command(id, 'start_trip');
      if (['ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(order.status)) {
        await this.driveTo({ lat: order.pickup_lat, lng: order.pickup_lng }, id);
        const photoId = `sim-${randomUUID()}`;
        await this.req(`/driver/photos/${photoId}`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PHOTO });
        await this.command(id, 'confirm_pickup', { photoId });
        this.log('picked up');
        if (OFFLINE_AFTER_PICKUP > 0) {
          this.offline = true;
          this.log(`going offline for ${OFFLINE_AFTER_PICKUP}s`);
          setTimeout(() => {
            this.offline = false;
            this.log('back online; syncing');
            void this.flush();
          }, OFFLINE_AFTER_PICKUP * 1000);
        }
        await this.command(id, 'start_dropoff');
      }
      await this.driveTo({ lat: order.dropoff_lat, lng: order.dropoff_lng }, id);
      // The receiver reads out the PIN. The simulator recovers it from the offline check data instead
      // (4 digits are easy to brute-force, which is why the server re-checks and rate-limits; ADR-0006).
      const pin = findPin(order.pinCheck.salt, order.pinCheck.hash);
      await this.command(id, 'confirm_delivery', { pin });
      while (this.offline || this.queue.length) await sleep(500);
      this.log('delivered');
    } catch (err: any) {
      this.log(`delivery stopped: ${err.message}`);
    }
  }
}

function findPin(salt: string, hash: string): string {
  for (let n = 0; n < 10_000; n++) {
    const pin = n.toString().padStart(4, '0');
    if (createHash('sha256').update(`${salt}:${pin}`).digest('hex') === hash) return pin;
  }
  throw new Error('pin not found');
}

async function main() {
  const drivers = DEMO_DRIVERS.slice(0, COUNT).map((d) => new SimDriver(d.name, d.email, d));
  await Promise.all(drivers.map((d) => d.run().catch((e) => d.log(`stopped: ${e.message}`))));
}

void main();
