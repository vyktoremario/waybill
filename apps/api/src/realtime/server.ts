import { createServer, type IncomingMessage, type Server } from 'node:http';
import Redis from 'ioredis';
import { WebSocketServer, type WebSocket } from 'ws';
import { AuthService } from '../auth/auth';
import { sha256 } from '../crypto';
import type { Db } from '../db/db';

/**
 * Realtime downlink (ADR-0003). Stateless: each instance subscribes to the Redis channels of the rooms its
 * clients joined and forwards messages. Clients reconnect and refetch a REST snapshot whenever the
 * connection drops (on Vercel, at least every max-duration).
 *
 * Protocol (JSON): client → {type:'join', room} ; server → {type:'joined', room} | {type:'error', message} | RealtimeMessage + {room}
 * Auth: ?token=<JWT> for dispatchers and drivers, ?tracking=<tracking token> for customers.
 */
export function attachRealtime(server: Server, deps: { db: Db; auth: AuthService; redisUrl: string }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sub = new Redis(deps.redisUrl);
  sub.on('error', (err) => console.error('[realtime] redis', err.message));
  const members = new Map<string, Set<WebSocket>>();

  sub.on('message', (channel: string, raw: string) => {
    const room = channel.slice(3);
    const set = members.get(room);
    if (!set) return;
    const out = JSON.stringify({ ...JSON.parse(raw), room });
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(out);
  });

  async function join(ws: WebSocket, room: string) {
    let set = members.get(room);
    if (!set) {
      set = new Set();
      members.set(room, set);
      await sub.subscribe(`rt:${room}`);
    }
    set.add(ws);
  }

  async function leaveAll(ws: WebSocket) {
    for (const [room, set] of members) {
      if (set.delete(ws) && set.size === 0) {
        members.delete(room);
        await sub.unsubscribe(`rt:${room}`).catch(() => undefined);
      }
    }
  }

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const principal = await deps.auth.verify(url.searchParams.get('token') ?? undefined);
    const tracking = url.searchParams.get('tracking');
    let trackedOrder: string | null = null;
    if (tracking) {
      const r = await deps.db.query(`SELECT id FROM orders WHERE tracking_token_hash = $1`, [sha256(tracking)]);
      trackedOrder = r.rows[0]?.id ?? null;
    }
    if (!principal && !trackedOrder) {
      ws.close(4401, 'unauthorized');
      return;
    }
    // Keep-alive so idle proxies don't cut the connection silently.
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 20_000);
    ws.on('close', () => {
      clearInterval(ping);
      void leaveAll(ws);
    });

    ws.on('message', async (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.type !== 'join' || typeof msg.room !== 'string') return;
      const room: string = msg.room;
      const allowed =
        (room === 'dispatch' && principal?.role === 'dispatcher') ||
        (room === `driver:${principal?.sub}` && principal?.role === 'driver') ||
        (room.startsWith('order:') && (principal?.role === 'dispatcher' || room === `order:${trackedOrder}`));
      if (!allowed) {
        ws.send(JSON.stringify({ type: 'error', message: `not allowed to join ${room}` }));
        return;
      }
      await join(ws, room);
      ws.send(JSON.stringify({ type: 'joined', room }));
    });
  });

  return {
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      sub.disconnect();
    },
  };
}

export function createRealtimeServer(deps: { db: Db; auth: AuthService; redisUrl: string }) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  const rt = attachRealtime(server, deps);
  return { server, close: rt.close };
}
