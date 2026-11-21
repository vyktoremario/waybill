import { AuthService } from '../auth/auth';
import { loadConfig } from '../config';
import { createPool } from '../db/db';
import { createRealtimeServer } from './server';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const { server } = createRealtimeServer({ db, auth: new AuthService(db, config.jwtSecret), redisUrl: config.redisUrl });
server.listen(config.realtimePort, '0.0.0.0', () => console.log(`[realtime] listening on :${config.realtimePort} (ws path /ws)`));
