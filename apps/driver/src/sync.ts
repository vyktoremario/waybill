import NetInfo from '@react-native-community/netinfo';
import { HttpError, call } from './api';
import { outbox, points, type OutboxRow } from './store';

export interface Conflict {
  orderId: string;
  message: string;
  serverStatus?: string;
  droppedActions: string[];
}

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pending: number;
  pendingPoints: number;
  conflict: Conflict | null;
  /** A validation error the driver must see (e.g. wrong PIN), cleared when read. */
  rejected: { type: string; message: string } | null;
}

type Listener = (s: SyncState) => void;

/**
 * The sync loop (ADR-0006): sends queued work oldest-first, one at a time, with backoff. The server
 * dedupes by commandId, so resending after a lost response is safe.
 * - 2xx: done.
 * - 409: stop, drop the order's queued work, show the conflict. Never try to "win".
 * - other 4xx: the command is invalid (e.g. wrong PIN): drop it and tell the driver.
 * - 5xx / network: keep it and retry later.
 */
class SyncEngine {
  private state: SyncState = { online: true, syncing: false, pending: 0, pendingPoints: 0, conflict: null, rejected: null };
  private listeners = new Set<Listener>();
  private running = false;
  private backoffMs = 1_000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onApplied: (() => void) | null = null;
  /** Lets the demo force "offline" without touching the phone's radio. */
  forcedOffline = false;

  start(onApplied: () => void) {
    this.onApplied = onApplied;
    NetInfo.addEventListener((s) => {
      const online = Boolean(s.isConnected) && s.isInternetReachable !== false && !this.forcedOffline;
      const cameBack = online && !this.state.online;
      this.set({ online });
      if (cameBack) this.kick();
    });
    this.refreshCounts();
    this.kick();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get snapshot(): SyncState {
    return this.state;
  }

  setForcedOffline(v: boolean) {
    this.forcedOffline = v;
    this.set({ online: !v });
    if (!v) this.kick();
  }

  clearConflict() {
    this.set({ conflict: null });
  }

  clearRejected() {
    this.set({ rejected: null });
  }

  /** Run the loop now (after enqueuing, or when the network returns). */
  kick() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backoffMs = 1_000;
    void this.loop();
  }

  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  refreshCounts() {
    this.set({ pending: outbox.count(), pendingPoints: points.count() });
  }

  private async loop() {
    if (this.running) return;
    this.running = true;
    this.set({ syncing: true });
    try {
      while (!this.forcedOffline) {
        const next = outbox.all()[0];
        const batch = points.batch();
        if (!next && batch.length === 0) break;
        if (next) await this.send(next);
        else await this.sendPoints(batch);
        this.refreshCounts();
        this.backoffMs = 1_000;
      }
    } catch {
      // Network or server trouble: back off and try again.
      const wait = this.backoffMs * (0.5 + Math.random() / 2);
      this.backoffMs = Math.min(60_000, this.backoffMs * 2);
      this.timer = setTimeout(() => void this.loop(), wait);
    } finally {
      this.running = false;
      this.set({ syncing: false });
      this.refreshCounts();
    }
  }

  private async sendPoints(batch: Array<{ seq: number; body: string }>) {
    await call('/driver/locations', { method: 'POST', body: JSON.stringify({ points: batch.map((b) => JSON.parse(b.body)) }) });
    points.removeUpTo(batch[batch.length - 1]!.seq);
  }

  private async send(row: OutboxRow) {
    outbox.bump(row.id);
    const body = JSON.parse(row.body);
    try {
      if (row.kind === 'photo') {
        const blob = await (await fetch(body.uri)).blob();
        await call(`/driver/photos/${row.id}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: blob });
      } else {
        await call('/driver/commands', { method: 'POST', body: row.body });
      }
      outbox.remove(row.id);
      this.onApplied?.();
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500 || err.status === 401) throw err;
      if (err.status === 409) {
        const dropped = outbox
          .all()
          .filter((r) => r.order_id === row.order_id && r.kind === 'command')
          .map((r) => JSON.parse(r.body).type as string);
        outbox.dropOrder(row.order_id);
        this.set({ conflict: { orderId: row.order_id, message: err.message, serverStatus: err.body?.status, droppedActions: dropped } });
      } else {
        outbox.remove(row.id);
        this.set({ rejected: { type: body.type ?? row.kind, message: err.message } });
      }
      this.onApplied?.();
    }
  }
}

export const sync = new SyncEngine();
