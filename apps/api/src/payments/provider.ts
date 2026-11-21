import { createHmac, timingSafeEqual } from 'node:crypto';

export type ChargeStatus = 'success' | 'failed' | 'abandoned' | 'pending' | 'not_found';

export interface PaymentProvider {
  readonly name: string;
  initialize(input: { reference: string; amountKobo: number; email: string; callbackUrl: string; metadata: Record<string, string> }): Promise<{ checkoutUrl: string }>;
  verify(reference: string): Promise<{ status: ChargeStatus; amountKobo?: number; currency?: string; refunded?: boolean }>;
  refund(reference: string, amountKobo: number): Promise<{ refundId: string | null; status: 'pending' | 'processed' }>;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: 'duplicate_reference' | 'already_refunded' | 'unavailable' | 'rejected',
  ) {
    super(message);
  }
}

/**
 * Paystack's REST API (test mode), or the local simulator that speaks the same API.
 * https://paystack.com/docs/api/transaction/ and /refund/
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ httpStatus: number; json: any }> {
    // Only status and json() are used. Typed locally because Vercel's NestJS build resolves a different
    // global Response type than local tsc does.
    const res = (await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err: any) => {
      throw new ProviderError(`paystack unreachable: ${err?.message ?? err}`, 'unavailable');
    })) as unknown as { status: number; json(): Promise<unknown> };
    const json: any = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new ProviderError(`paystack ${res.status}`, 'unavailable');
    return { httpStatus: res.status, json };
  }

  async initialize(input: { reference: string; amountKobo: number; email: string; callbackUrl: string; metadata: Record<string, string> }) {
    const { json } = await this.call('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountKobo,
      currency: 'NGN',
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    });
    if (!json.status) {
      const msg = String(json.message ?? 'initialize failed');
      throw new ProviderError(msg, /duplicate/i.test(msg) ? 'duplicate_reference' : 'rejected');
    }
    return { checkoutUrl: json.data.authorization_url as string };
  }

  async verify(reference: string): Promise<{ status: ChargeStatus; amountKobo?: number; currency?: string; refunded?: boolean }> {
    const { json } = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!json.status) {
      if (/not found/i.test(String(json.message))) return { status: 'not_found' as const };
      throw new ProviderError(String(json.message ?? 'verify failed'), 'rejected');
    }
    const s = String(json.data.status);
    // Paystack reports a fully refunded charge as "reversed": it did succeed, and has since been refunded.
    const status: ChargeStatus = s === 'success' || s === 'reversed' ? 'success' : s === 'failed' ? 'failed' : s === 'abandoned' ? 'abandoned' : 'pending';
    return { status, amountKobo: Number(json.data.amount), currency: String(json.data.currency ?? 'NGN'), refunded: s === 'reversed' };
  }

  async refund(reference: string, amountKobo: number) {
    const { json } = await this.call('POST', '/refund', { transaction: reference, amount: amountKobo });
    if (!json.status) {
      const msg = String(json.message ?? 'refund failed');
      throw new ProviderError(msg, /fully reversed|already/i.test(msg) ? 'already_refunded' : 'rejected');
    }
    const status = json.data?.status === 'processed' ? ('processed' as const) : ('pending' as const);
    return { refundId: json.data?.id != null ? String(json.data.id) : null, status };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const want = createHmac('sha512', this.secretKey).update(rawBody).digest();
    const got = Buffer.from(signature, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}
