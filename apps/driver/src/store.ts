import * as SQLite from 'expo-sqlite';

/**
 * Durable local state (ADR-0006). Commands and location points are written here BEFORE the UI changes,
 * so nothing a driver does is lost if the app is killed or the phone has no signal.
 */
const db = SQLite.openDatabaseSync('waybill-driver.db');

db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY NOT NULL,          -- commandId, or the photo id for uploads
    kind TEXT NOT NULL,                    -- 'command' | 'photo'
    order_id TEXT NOT NULL,
    body TEXT NOT NULL,                    -- JSON: the command, or { uri }
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS points (seq INTEGER PRIMARY KEY NOT NULL, body TEXT NOT NULL);
`);

export const kv = {
  get(key: string): string | null {
    return db.getFirstSync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  },
  set(key: string, value: string | null) {
    if (value === null) db.runSync('DELETE FROM kv WHERE key = ?', key);
    else db.runSync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  },
};

export interface OutboxRow {
  id: string;
  kind: 'command' | 'photo';
  order_id: string;
  body: string;
  created_at: number;
  attempts: number;
}

export const outbox = {
  add(row: Omit<OutboxRow, 'attempts' | 'created_at'>) {
    db.runSync('INSERT OR IGNORE INTO outbox (id, kind, order_id, body, created_at) VALUES (?, ?, ?, ?, ?)', row.id, row.kind, row.order_id, row.body, Date.now());
  },
  /** Oldest first: commands for an order must reach the server in the order they happened. */
  all(): OutboxRow[] {
    return db.getAllSync<OutboxRow>('SELECT * FROM outbox ORDER BY created_at, rowid');
  },
  remove(id: string) {
    db.runSync('DELETE FROM outbox WHERE id = ?', id);
  },
  dropOrder(orderId: string) {
    db.runSync('DELETE FROM outbox WHERE order_id = ?', orderId);
  },
  bump(id: string) {
    db.runSync('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?', id);
  },
  count(): number {
    return db.getFirstSync<{ n: number }>('SELECT count(*) AS n FROM outbox')?.n ?? 0;
  },
};

/** Location points, capped at ~2 h at one point per 10 s; older ones are thinned out. */
const MAX_POINTS = 720;
export const points = {
  nextSeq(): number {
    const n = Number(kv.get('seq') ?? Date.now());
    kv.set('seq', String(n + 1));
    return n;
  },
  add(seq: number, p: unknown) {
    db.runSync('INSERT OR IGNORE INTO points (seq, body) VALUES (?, ?)', seq, JSON.stringify(p));
    const n = db.getFirstSync<{ n: number }>('SELECT count(*) AS n FROM points')?.n ?? 0;
    if (n > MAX_POINTS) db.runSync('DELETE FROM points WHERE seq IN (SELECT seq FROM points ORDER BY seq LIMIT ? ) AND seq % 2 = 0', n - MAX_POINTS + 50);
  },
  batch(limit = 500): Array<{ seq: number; body: string }> {
    return db.getAllSync('SELECT seq, body FROM points ORDER BY seq LIMIT ?', limit);
  },
  removeUpTo(seq: number) {
    db.runSync('DELETE FROM points WHERE seq <= ?', seq);
  },
  count(): number {
    return db.getFirstSync<{ n: number }>('SELECT count(*) AS n FROM points')?.n ?? 0;
  },
};
