function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

export interface Config {
  databaseUrl: string;
  amqpUrl: string;
  redisUrl: string;
  jwtSecret: string;
  pinSecret: string;
  port: number;
  realtimePort: number;
  webUrl: string;
  paystackBaseUrl: string;
  paystackSecretKey: string;
  offerTtlSeconds: number;
  assignmentAlertSeconds: number;
  assignmentSlaSeconds: number;
  paymentExpirySeconds: number;
  reconcileIntervalSeconds: number;
  reconcileAfterSeconds: number;
  /** Enables the /hookstorm/reset and /hookstorm/state routes. Never in production. */
  hookstormRoutes: boolean;
}

export function loadConfig(): Config {
  return {
    databaseUrl: str('DATABASE_URL', 'postgres://waybill:waybill@127.0.0.1:55432/waybill'),
    amqpUrl: str('AMQP_URL', 'amqp://guest:guest@127.0.0.1:55672'),
    redisUrl: str('REDIS_URL', 'redis://127.0.0.1:56379'),
    jwtSecret: str('JWT_SECRET', 'dev-only-change-me'),
    pinSecret: str('PIN_SECRET', 'dev-only-change-me-too'),
    port: num('PORT', 4000),
    realtimePort: num('REALTIME_PORT', 4001),
    webUrl: str('WEB_URL', 'http://localhost:3000'),
    paystackBaseUrl: str('PAYSTACK_BASE_URL', 'http://127.0.0.1:4100'),
    paystackSecretKey: str('PAYSTACK_SECRET_KEY', 'sk_test_waybill_local'),
    offerTtlSeconds: num('OFFER_TTL_SECONDS', 30),
    assignmentAlertSeconds: num('ASSIGNMENT_ALERT_SECONDS', 600),
    assignmentSlaSeconds: num('ASSIGNMENT_SLA_SECONDS', 1200),
    paymentExpirySeconds: num('PAYMENT_EXPIRY_SECONDS', 1800),
    reconcileIntervalSeconds: num('RECONCILE_INTERVAL_SECONDS', 30),
    reconcileAfterSeconds: num('RECONCILE_AFTER_SECONDS', 120),
    hookstormRoutes: process.env.HOOKSTORM_ROUTES === '1',
  };
}
