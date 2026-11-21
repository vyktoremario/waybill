import { createServer } from 'node:http';
import { AuthService } from '../../api/src/auth/auth';
import { loadConfig } from '../../api/src/config';
import { createPool } from '../../api/src/db/db';
import { attachRealtime } from '../../api/src/realtime/server';

/**
 * The realtime downlink as a Vercel Function with WebSocket support (ADR-0003). Connections close at the
 * function's max duration (300 s on Hobby); clients reconnect and refetch, which they do on every reconnect anyway.
 * Endpoint: wss://<this project>/api/ws?token=… or ?tracking=…
 */
const config = loadConfig();
const db = createPool(config.databaseUrl);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"service":"realtime"}');
});
attachRealtime(server, { db, auth: new AuthService(db, config.jwtSecret), redisUrl: config.redisUrl }, { path: undefined });

export default server;
