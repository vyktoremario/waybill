import type { Config } from './config';
import { createPool, type Db } from './db/db';
import { AssignmentService } from './dispatch/assignment.service';
import { DriverService } from './dispatch/driver.service';
import { OrdersService } from './orders/orders.service';
import { PaymentsService } from './payments/payments.service';
import { PaystackProvider, type PaymentProvider } from './payments/provider';
import { RedisPublisher, type RealtimePublisher } from './realtime/publisher';

/** Plain wiring shared by the api, the worker and the tests. */
export interface Core {
  config: Config;
  db: Db;
  realtime: RealtimePublisher;
  provider: PaymentProvider;
  orders: OrdersService;
  payments: PaymentsService;
  assignment: AssignmentService;
  drivers: DriverService;
  close(): Promise<void>;
}

export function createCore(config: Config, overrides: { realtime?: RealtimePublisher; provider?: PaymentProvider; db?: Db } = {}): Core {
  const db = overrides.db ?? createPool(config.databaseUrl);
  const realtime = overrides.realtime ?? new RedisPublisher(config.redisUrl);
  const provider = overrides.provider ?? new PaystackProvider(config.paystackBaseUrl, config.paystackSecretKey);
  return {
    config,
    db,
    realtime,
    provider,
    orders: new OrdersService(db, config),
    payments: new PaymentsService(db, provider, config),
    assignment: new AssignmentService(db, config),
    drivers: new DriverService(db, realtime),
    async close() {
      await realtime.close();
      await db.end();
    },
  };
}
