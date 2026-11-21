import { isPaidPrePickup } from '@waybill/shared';
import { uuidv7 } from 'uuidv7';
import type { Config } from '../config';
import { withTx, type Db, type Tx } from '../db/db';
import { conflict, invalid, notFound } from '../errors';
import { post } from '../ledger/ledger';
import { cancelInTx } from '../orders/orders.service';
import { applyOrderEvent } from '../orders/transitions';
import { enqueue } from '../outbox/outbox';
import { ProviderError, type PaymentProvider } from './provider';

/**
 * Payments (ADR-0004). The provider's word is an input, never the trigger: a verified webhook or a
 * server-side verify call moves a payment forward, through the same code, exactly once.
 */
export class PaymentsService {
  constructor(
    private readonly db: Db,
    private readonly provider: PaymentProvider,
    private readonly config: Config,
    private readonly log: (msg: string) => void = (m) => console.log(`[payments] ${m}`),
  ) {}

  /** Starts (or resumes) checkout. The same idempotency key always returns the same checkout. */
  async initiate(orderId: string, idempotencyKey: string, callbackUrl?: string): Promise<{ paymentId: string; checkoutUrl: string; reference: string }> {
    if (!idempotencyKey || idempotencyKey.length > 200) throw invalid('Idempotency-Key header is required');
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = attempt === 0 ? idempotencyKey : `${idempotencyKey}:retry:${attempt}`;
      const payment = await withTx(this.db, async (tx) => {
        const order = (await tx.query(`SELECT id, status, price_kobo::int AS price, customer_email FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
        if (!order) throw notFound('order not found');
        const existing = (await tx.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key])).rows[0];
        if (existing) {
          if (existing.order_id !== orderId) throw conflict('idempotency key was used for another order');
          return { ...existing, email: order.customer_email };
        }
        if (order.status !== 'AWAITING_PAYMENT') throw conflict(`order is ${order.status}, not awaiting payment`, { status: order.status });
        const id = uuidv7();
        const row = (
          await tx.query(
            `INSERT INTO payments (id, order_id, provider, provider_reference, idempotency_key, amount_kobo, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'initiated') RETURNING *`,
            [id, orderId, this.provider.name, `wb_${id}`, key, order.price],
          )
        ).rows[0];
        return { ...row, email: order.customer_email };
      });
      if (payment.checkout_url) return { paymentId: payment.id, checkoutUrl: payment.checkout_url, reference: payment.provider_reference };

      try {
        const { checkoutUrl } = await this.provider.initialize({
          reference: payment.provider_reference,
          amountKobo: Number(payment.amount_kobo),
          email: payment.email,
          callbackUrl: callbackUrl ?? `${this.config.webUrl}/`,
          metadata: { orderId, paymentId: payment.id },
        });
        await this.db.query(`UPDATE payments SET checkout_url = $2, updated_at = now() WHERE id = $1`, [payment.id, checkoutUrl]);
        return { paymentId: payment.id, checkoutUrl, reference: payment.provider_reference };
      } catch (err) {
        // A previous attempt registered this reference but crashed before saving the URL; start a fresh one.
        if (err instanceof ProviderError && err.kind === 'duplicate_reference') continue;
        throw err;
      }
    }
    throw new Error('could not initialize payment');
  }

  /** Webhook entry point. Returns normally only after the effect is committed; throws so the provider retries. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (!this.provider.verifySignature(rawBody, signature)) throw invalid('bad signature');
    const body = JSON.parse(rawBody.toString('utf8'));
    const event = String(body.event ?? '');
    const data = body.data ?? {};
    const reference = String(data.reference ?? data.transaction_reference ?? '');
    const eventId = `${event}:${reference}:${data.id ?? ''}`;

    return withTx(this.db, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO inbox (provider, event_id, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [this.provider.name, eventId, body],
      );
      if (!inserted.rowCount) return 'duplicate';
      if (event === 'charge.success') {
        await this.applyChargeSuccess(tx, reference, Number(data.amount), String(data.currency ?? 'NGN'), `webhook ${eventId}`);
        return 'processed';
      }
      if (event === 'refund.processed') {
        await this.completeRefundByReference(tx, reference);
        return 'processed';
      }
      return 'ignored';
    });
  }

  /**
   * A charge succeeded. Forward-only: a payment that already succeeded or was refunded is left alone.
   * The first success for an order still awaiting payment pays for it; any other success is an
   * "extra" payment that is refunded (duplicate checkout, payment after expiry or cancel).
   */
  async applyChargeSuccess(tx: Tx, reference: string, amountKobo: number, currency: string, source: string): Promise<void> {
    const payment = (await tx.query(`SELECT * FROM payments WHERE provider_reference = $1 FOR UPDATE`, [reference])).rows[0];
    if (!payment) {
      this.log(`charge.success for unknown reference ${reference} (${source}); ignored`);
      return;
    }
    if (!['initiated', 'failed'].includes(payment.status)) return;

    const order = (await tx.query(`SELECT id, status, price_kobo::int AS price FROM orders WHERE id = $1 FOR UPDATE`, [payment.order_id])).rows[0];
    const hasPrimary = (await tx.query(`SELECT 1 FROM payments WHERE order_id = $1 AND role = 'primary'`, [order.id])).rowCount;
    const amountOk = amountKobo === Number(payment.amount_kobo) && currency === 'NGN';
    // What actually moved is the amount the provider reports, which is what we'd refund.
    const received = Number.isFinite(amountKobo) && amountKobo > 0 ? amountKobo : Number(payment.amount_kobo);

    if (order.status === 'AWAITING_PAYMENT' && !hasPrimary && amountOk) {
      await tx.query(`UPDATE payments SET status = 'succeeded', role = 'primary', updated_at = now() WHERE id = $1`, [payment.id]);
      await post(
        tx,
        [
          { account: 'provider_clearing', amountKobo: received },
          { account: 'order_liability', amountKobo: -received },
        ],
        { memo: `payment ${reference}`, orderId: order.id, paymentId: payment.id },
      );
      await applyOrderEvent(tx, {
        orderId: order.id,
        event: 'payment_succeeded',
        actor: 'system',
        payload: { reference, source },
        patch: { paid_at: new Date() },
      });
      await enqueue(tx, { type: 'order.paid', payload: { orderId: order.id } }, { aggregateId: order.id });
      await enqueue(tx, { type: 'order.assignment_check', payload: { orderId: order.id } }, { aggregateId: order.id, delayMs: this.config.assignmentAlertSeconds * 1000 });
      await enqueue(tx, { type: 'order.assignment_check', payload: { orderId: order.id } }, { aggregateId: order.id, delayMs: this.config.assignmentSlaSeconds * 1000 });
      return;
    }

    const why = !amountOk ? 'amount mismatch' : hasPrimary ? 'order already paid' : `order is ${order.status}`;
    this.log(`extra payment ${reference} (${why}); refunding`);
    await tx.query(`UPDATE payments SET status = 'succeeded', role = 'extra', updated_at = now() WHERE id = $1`, [payment.id]);
    await post(
      tx,
      [
        { account: 'provider_clearing', amountKobo: received },
        { account: 'refunds_payable', amountKobo: -received },
      ],
      { memo: `extra payment ${reference}: ${why}`, orderId: order.id, paymentId: payment.id },
    );
    await enqueue(tx, { type: 'payment.refund_required', payload: { paymentId: payment.id, reason: why } }, { aggregateId: order.id });
  }

  /** Refund consumer (idempotent). Records the refund before calling the provider. */
  async refund(paymentId: string, reason: string): Promise<void> {
    const prep = await withTx(this.db, async (tx) => {
      const p = (await tx.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId])).rows[0];
      if (!p) throw notFound('payment not found');
      if (p.status === 'refunded') return null;
      if (!['succeeded', 'refund_pending'].includes(p.status)) throw conflict(`cannot refund a ${p.status} payment`);
      await tx.query(
        `INSERT INTO refunds (id, payment_id, amount_kobo, reason, status) VALUES ($1, $2, $3, $4, 'requested') ON CONFLICT (payment_id) DO NOTHING`,
        [uuidv7(), p.id, p.amount_kobo, reason],
      );
      const r = (await tx.query(`SELECT * FROM refunds WHERE payment_id = $1`, [p.id])).rows[0];
      await tx.query(`UPDATE payments SET status = 'refund_pending', updated_at = now() WHERE id = $1`, [p.id]);
      return r.status === 'requested' ? { reference: p.provider_reference as string, amount: Number(p.amount_kobo) } : null;
    });
    if (!prep) return;

    let result: { refundId: string | null; status: 'pending' | 'processed' };
    try {
      result = await this.provider.refund(prep.reference, prep.amount);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'already_refunded') {
        // An earlier attempt reached the provider but we crashed before recording it.
        result = { refundId: null, status: 'processed' };
      } else throw err;
    }
    await withTx(this.db, async (tx) => {
      await tx.query(
        `UPDATE refunds SET status = CASE WHEN status = 'processed' THEN status ELSE 'pending' END,
                provider_refund_id = COALESCE(provider_refund_id, $2), updated_at = now() WHERE payment_id = $1`,
        [paymentId, result.refundId],
      );
      if (result.status === 'processed') await this.completeRefund(tx, paymentId);
    });
  }

  async completeRefundByReference(tx: Tx, reference: string): Promise<void> {
    const p = (await tx.query(`SELECT id, status, amount_kobo FROM payments WHERE provider_reference = $1 FOR UPDATE`, [reference])).rows[0];
    if (!p) {
      this.log(`refund.processed for unknown reference ${reference}; ignored`);
      return;
    }
    // A refund can arrive before the charge's own webhook (reordering). Only a successful charge can be
    // refunded, so record the charge first; its late webhook will then be a no-op.
    if (p.status === 'initiated' || p.status === 'failed') {
      await this.applyChargeSuccess(tx, reference, Number(p.amount_kobo), 'NGN', 'implied by refund');
    }
    await this.completeRefund(tx, p.id);
  }

  /** The refund reached the customer. Forward-only and idempotent. */
  async completeRefund(tx: Tx, paymentId: string): Promise<void> {
    const p = (await tx.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId])).rows[0];
    if (!p || p.status === 'refunded') return;
    const r = (await tx.query(`SELECT * FROM refunds WHERE payment_id = $1 FOR UPDATE`, [paymentId])).rows[0];
    if (!r) {
      // A refund we never asked for (e.g. made in the provider's dashboard). Record it so the books match.
      await tx.query(
        `INSERT INTO refunds (id, payment_id, amount_kobo, reason, status) VALUES ($1, $2, $3, 'refunded outside Waybill', 'processed')`,
        [uuidv7(), p.id, p.amount_kobo],
      );
      if (p.role === 'primary') {
        const order = (await tx.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [p.order_id])).rows[0];
        if (isPaidPrePickup(order.status)) {
          // The customer got their money back before pickup: the order can't go ahead (reverses the liability).
          await cancelInTx(tx, { orderId: p.order_id, actor: 'system', reason: 'payment refunded' });
        } else {
          await post(
            tx,
            [
              { account: 'order_liability', amountKobo: Number(p.amount_kobo) },
              { account: 'refunds_payable', amountKobo: -Number(p.amount_kobo) },
            ],
            { memo: `external refund ${p.provider_reference}`, orderId: p.order_id, paymentId: p.id },
          );
        }
      }
    } else {
      await tx.query(`UPDATE refunds SET status = 'processed', updated_at = now() WHERE id = $1`, [r.id]);
    }
    await tx.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [p.id]);
    await post(
      tx,
      [
        { account: 'refunds_payable', amountKobo: Number(p.amount_kobo) },
        { account: 'provider_clearing', amountKobo: -Number(p.amount_kobo) },
      ],
      { memo: `refund processed ${p.provider_reference}`, orderId: p.order_id, paymentId: p.id },
    );
  }

  /**
   * Safety net for lost webhooks (F7): ask the provider about payments that have been waiting a while,
   * and expire orders nobody paid for.
   */
  async reconcile(): Promise<{ checked: number; succeeded: number; expired: number }> {
    const stale = await this.db.query(
      `SELECT id, provider_reference, created_at FROM payments
        WHERE status = 'initiated' AND created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 50`,
      [this.config.reconcileAfterSeconds],
    );
    let succeeded = 0;
    let expired = 0;
    for (const p of stale.rows) {
      let v;
      try {
        v = await this.provider.verify(p.provider_reference);
      } catch (err: any) {
        this.log(`verify ${p.provider_reference} failed: ${err.message}`);
        continue;
      }
      if (v.status === 'success') {
        await withTx(this.db, (tx) => this.applyChargeSuccess(tx, p.provider_reference, v.amountKobo ?? 0, v.currency ?? 'NGN', 'reconciler'));
        succeeded++;
        continue;
      }
      const old = Date.now() - new Date(p.created_at).getTime() > this.config.paymentExpirySeconds * 1000;
      if (old || v.status === 'failed') {
        await withTx(this.db, async (tx) => {
          const row = (await tx.query(`SELECT status, order_id FROM payments WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
          if (row.status !== 'initiated') return;
          await tx.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
          const order = (await tx.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [row.order_id])).rows[0];
          const others = await tx.query(`SELECT 1 FROM payments WHERE order_id = $1 AND status = 'initiated'`, [row.order_id]);
          if (old && order.status === 'AWAITING_PAYMENT' && !others.rowCount) {
            await applyOrderEvent(tx, { orderId: row.order_id, event: 'payment_expired', actor: 'system' });
            expired++;
          }
        });
      }
    }
    // Refunds the provider accepted but whose completion we never heard about.
    const pending = await this.db.query(
      `SELECT r.payment_id, p.provider_reference FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE r.status = 'pending' AND r.updated_at < now() - make_interval(secs => $1) LIMIT 50`,
      [this.config.reconcileAfterSeconds],
    );
    for (const r of pending.rows) {
      try {
        const v = await this.provider.verify(r.provider_reference);
        if (v.refunded) await withTx(this.db, (tx) => this.completeRefund(tx, r.payment_id));
      } catch {
        /* try again next round */
      }
    }
    return { checked: stale.rowCount ?? 0, succeeded, expired };
  }
}
