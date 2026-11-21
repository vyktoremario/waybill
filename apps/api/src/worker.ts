import { loadConfig } from './config';
import { createCore, type Core } from './core';
import { migrate } from './db/migrate';
import { Rabbit, type ConsumerSpec } from './mq/rabbit';
import { OutboxRelay } from './outbox/relay';

/** The consumers (ADR-0005). Every handler is safe to run more than once. */
export function consumers(core: Core): ConsumerSpec[] {
  return [
    {
      name: 'dispatch.assignment',
      bindings: ['order.paid', 'order.needs_driver', 'offer.expire_check', 'order.assignment_check', 'driver.status_changed'],
      async handle(type, p) {
        if (type === 'order.paid' || type === 'order.needs_driver') await core.assignment.tryAssign(p.orderId);
        else if (type === 'offer.expire_check') await core.assignment.expireOffer(p.offerId);
        else if (type === 'order.assignment_check') await core.assignment.assignmentCheck(p.orderId);
        else if (type === 'driver.status_changed' && p.status === 'available') await core.assignment.onDriverAvailable();
      },
    },
    {
      name: 'payments.refunds',
      bindings: ['payment.refund_required'],
      async handle(_type, p) {
        await core.payments.refund(p.paymentId, p.reason);
      },
    },
    {
      name: 'realtime.fanout',
      bindings: ['order.status_changed', 'offer.created', 'driver.status_changed'],
      async handle(type, p) {
        if (type === 'order.status_changed') {
          const o = (await core.db.query(`SELECT driver_id, status, version, updated_at FROM orders WHERE id = $1`, [p.orderId])).rows[0];
          if (!o) return;
          // Send the current state, not the event's: a late or duplicate message never rolls a screen back.
          const msg = { type: 'order' as const, orderId: p.orderId, status: o.status, version: o.version, at: new Date(o.updated_at).toISOString() };
          await core.realtime.publish(`order:${p.orderId}`, msg);
          await core.realtime.publish('dispatch', msg);
          if (o.driver_id) await core.realtime.publish(`driver:${o.driver_id}`, msg);
        } else if (type === 'offer.created') {
          await core.realtime.publish(`driver:${p.driverId}`, { type: 'offer', offerId: p.offerId, orderId: p.orderId, expiresAt: p.expiresAt });
          await core.realtime.publish('dispatch', { type: 'offer', offerId: p.offerId, orderId: p.orderId, expiresAt: p.expiresAt });
        } else if (type === 'driver.status_changed') {
          const msg = { type: 'driver' as const, driverId: p.driverId, status: p.status };
          await core.realtime.publish(`driver:${p.driverId}`, msg);
          await core.realtime.publish('dispatch', msg);
        }
      },
    },
  ];
}

async function main() {
  const config = loadConfig();
  await migrate(config.databaseUrl, { quiet: true });
  const core = createCore(config);
  const rabbit = new Rabbit(config.amqpUrl);
  await rabbit.connect();
  // Crash-only: if the broker connection drops, exit and let the supervisor (Vercel Daemon / docker) restart us.
  rabbit.onClose(() => {
    console.error('[worker] broker connection closed; exiting');
    process.exit(1);
  });
  for (const spec of consumers(core)) await rabbit.consume(core.db, spec);

  const relay = new OutboxRelay(core.db, rabbit, config.databaseUrl);
  await relay.start();

  let reconciling = false;
  const timer = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const r = await core.payments.reconcile();
      if (r.succeeded || r.expired) console.log(`[reconcile] checked ${r.checked}, completed ${r.succeeded}, expired ${r.expired}`);
    } catch (err: any) {
      console.error(`[reconcile] ${err.message}`);
    } finally {
      reconciling = false;
    }
  }, config.reconcileIntervalSeconds * 1000);

  const healthTimer = setInterval(async () => {
    let total = 0;
    for (const spec of consumers(core)) total += Math.max(0, await rabbit.depth(`${spec.name}.dlq`));
    await core.realtime.setKey('health:dlq', String(total), 30);
  }, 5_000);

  console.log('[worker] running');
  const shutdown = async (signal: string) => {
    // SIGTERM on deploys: stop taking work, finish the batch in flight, exit within the grace period.
    console.log(`[worker] ${signal}: draining`);
    clearInterval(timer);
    clearInterval(healthTimer);
    await relay.stop();
    await rabbit.close();
    await core.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[worker] fatal', err);
    process.exit(1);
  });
}
