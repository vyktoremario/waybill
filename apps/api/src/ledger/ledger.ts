import { uuidv7 } from 'uuidv7';
import type { Tx } from '../db/db';

/**
 * Double-entry ledger (SPEC §5). Accounts:
 * - provider_clearing        money Paystack holds for us (+ when a charge succeeds, − when refunded)
 * - order_liability          what we owe customers in deliveries (− when paid, + when delivered or refunded)
 * - refunds_payable          refunds we've committed to and not yet completed
 * - driver_payable:<id>      driver earnings owed
 * - platform_revenue         our fee
 * Each group sums to zero; a deferred trigger rejects the transaction otherwise.
 */
export interface Leg {
  account: string;
  amountKobo: number;
}

export async function post(
  tx: Tx,
  legs: Leg[],
  ref: { memo: string; orderId?: string; paymentId?: string },
): Promise<string> {
  const group = uuidv7();
  for (const leg of legs) {
    if (!Number.isInteger(leg.amountKobo)) throw new Error(`ledger amount must be integer kobo: ${leg.amountKobo}`);
    await tx.query(
      `INSERT INTO ledger_entries (entry_group, account, order_id, payment_id, amount_kobo, memo) VALUES ($1, $2, $3, $4, $5, $6)`,
      [group, leg.account, ref.orderId ?? null, ref.paymentId ?? null, leg.amountKobo, ref.memo],
    );
  }
  return group;
}
