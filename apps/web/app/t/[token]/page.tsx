'use client';

import dynamic from 'next/dynamic';
import { Check, Loader2, Share2 } from 'lucide-react';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Logo } from '@/components/Brand';
import { Skeleton, useToast } from '@/components/Toast';
import { API_URL, api } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { STATUS_LABEL, fmtTime, naira, shortRef } from '@/lib/status';

const LiveMap = dynamic(() => import('@/components/LiveMap').then((m) => m.LiveMap), { ssr: false });

const STEPS: Array<{ label: string; reached: string[] }> = [
  { label: 'Paid', reached: ['PAID', 'OFFERED', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED'] },
  { label: 'Driver assigned', reached: ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED'] },
  { label: 'Picked up', reached: ['PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'DELIVERED'] },
  { label: 'Delivered', reached: ['DELIVERED'] },
];

export default function TrackingPage() {
  const { token } = useParams<{ token: string }>();
  // Paystack sends the customer back with ?reference=…; the webhook may land a few seconds later.
  const returnedFromCheckout = Boolean(useSearchParams().get('reference'));
  const toast = useToast();
  const [o, setO] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setO(await api(`/track/${token}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const conn = useRealtime({
    auth: o ? { tracking: token } : null,
    rooms: o ? [`order:${o.id}`] : [],
    onResync: load,
    onMessage: (msg) => {
      if (msg.type === 'location') setO((cur: any) => (cur ? { ...cur, driverLocation: { lat: msg.lat, lng: msg.lng, at: msg.recordedAt } } : cur));
      else if (msg.type === 'order') void load();
    },
  });

  // Payment confirmations are asynchronous: poll briefly after returning from checkout.
  useEffect(() => {
    if (o?.status !== 'AWAITING_PAYMENT') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [o?.status, load]);

  if (error && !o) return <Shell><div className="banner banner-problem" role="alert">{error}</div></Shell>;
  if (!o)
    return (
      <Shell>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-busy="true" aria-label="Loading your delivery">
          <Skeleton h={14} w={120} />
          <Skeleton h={34} w="80%" />
          <Skeleton h={16} w="55%" />
          <Skeleton h={150} r={12} />
          <Skeleton h={110} r={12} />
        </div>
      </Shell>
    );

  const label = STATUS_LABEL[o.status] ?? { customer: o.status, tone: 'neutral' };
  const live = Boolean(o.driverLocation);
  const points = [
    { id: 'dropoff', kind: 'dropoff' as const, lat: o.dropoff.lat, lng: o.dropoff.lng, label: 'Drop-off' },
    ...(live ? [{ id: 'driver', kind: 'driver' as const, lat: o.driverLocation.lat, lng: o.driverLocation.lng, label: 'Driver' }] : []),
  ];
  const at = (to: string) => o.timeline.find((e: any) => e.to === to)?.at;

  async function pay() {
    setBusy(true);
    try {
      const r = await api<{ checkoutUrl: string }>(`/track/${token}/pay`, { method: 'POST', headers: { 'idempotency-key': `checkout:${o.id}` } });
      window.location.href = r.checkoutUrl;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm('Cancel this delivery? If you have paid, the refund goes back to your card.')) return;
    setBusy(true);
    try {
      setO(await api(`/track/${token}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'cancelled by customer', commandId: crypto.randomUUID() }) }));
      toast('Delivery cancelled. Any payment is being refunded.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell refId={shortRef(o.id)}>
      {live && (
        <div style={{ height: 240, margin: '0 -16px', position: 'relative' }}>
          <LiveMap points={points} center={o.driverLocation} fitTo={['driver', 'dropoff']} />
          <span className="chip chip-neutral" style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 1 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: conn === 'live' ? 'var(--done)' : 'var(--attention)' }} />
            {conn === 'live' ? `Live · ${fmtTime(o.driverLocation.at)}` : 'Reconnecting…'}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="eyebrow">{label.customer}</span>
        <h1 style={{ fontSize: 30, lineHeight: 1.1 }}>{headline(o)}</h1>
        <span style={{ color: 'var(--ink-2)' }}>
          {o.driver ? `Driver: ${o.driver.name}, ${o.driver.vehicle}` : `${o.item} · ${o.packageSize} parcel`}
        </span>
      </div>

      {o.status === 'AWAITING_PAYMENT' && returnedFromCheckout && (
        <div className="card fade-in" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }} role="status">
          <Loader2 size={22} className="spin" aria-hidden="true" style={{ color: 'var(--cobalt)', flex: 'none' }} />
          <span><strong>Confirming your payment with Paystack.</strong> This usually takes a few seconds; the page updates by itself.</span>
        </div>
      )}

      {o.status === 'AWAITING_PAYMENT' && !returnedFromCheckout && (
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span>Waiting for your payment of <strong className="mono">{naira(o.priceKobo)}</strong>. If you just paid, this updates in a few seconds.</span>
          <button className="btn btn-primary" onClick={pay} disabled={busy}>Pay {naira(o.priceKobo)}</button>
        </div>
      )}

      {o.pin && !['DELIVERED', 'CANCELLED', 'RETURNED'].includes(o.status) && (
        <div className="card-strong" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontWeight: 600 }}>Delivery PIN</span>
          <div className="pin" aria-label={`PIN ${o.pin.split('').join(' ')}`}>{o.pin.split('').map((d: string, i: number) => <span key={i}>{d}</span>)}</div>
          <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>Only give this to the driver when the parcel is in your hands. Share this page with whoever receives it.</span>
          <button className="btn btn-secondary" onClick={() => void share()}><Share2 size={18} aria-hidden="true" />Share tracking link</button>
        </div>
      )}

      {!live && ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PAID', 'OFFERED'].includes(o.status) && (
        <div className="card" style={{ padding: 14, fontSize: 14, color: 'var(--ink-2)' }}>The live map appears once your parcel is picked up.</div>
      )}

      {o.status === 'CANCELLED' && (
        <div className="banner banner-problem">Cancelled: {o.cancelReason}. {o.payment?.status === 'refunded' ? 'Your refund has been processed.' : o.payment?.status === 'refund_pending' || o.payment?.status === 'succeeded' ? 'Your refund is on its way.' : ''}</div>
      )}

      <ol className="steps">
        {STEPS.map((s, i) => {
          const done = s.reached.includes(o.status);
          const now = !done && (i === 0 || STEPS[i - 1]!.reached.includes(o.status)) && !['CANCELLED', 'EXPIRED', 'AWAITING_PAYMENT'].includes(o.status);
          const when = at(['PAID', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'][i]!);
          return (
            <li key={s.label} style={{ fontWeight: now ? 700 : 400, color: done || now ? 'var(--ink)' : 'var(--muted)' }}>
              <span className={`dot ${done ? 'dot-done' : now ? 'dot-now' : 'dot-next'}`} aria-hidden="true">{done ? <Check size={13} strokeWidth={3} /> : null}</span>
              {s.label}
              <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 500 }}>{done && when ? fmtTime(when) : now ? 'Now' : ''}</span>
            </li>
          );
        })}
      </ol>

      {o.status === 'DELIVERED' && o.hasPickupPhoto && (
        <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <figcaption style={{ fontWeight: 600, fontSize: 14 }}>Pickup photo</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${API_URL}/track/${token}/photo`} alt="The parcel at pickup" style={{ width: '100%', borderRadius: 12, border: '1px solid var(--line)' }} />
        </figure>
      )}

      {['AWAITING_PAYMENT', 'PAID', 'OFFERED'].includes(o.status) && (
        <button className="btn btn-ghost-danger" onClick={cancel} disabled={busy}>Cancel delivery</button>
      )}
      {error && <div className="banner banner-problem" role="alert">{error}</div>}
    </Shell>
  );

  async function share() {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: 'Track your Waybill delivery', url }).catch(() => undefined);
    else await navigator.clipboard.writeText(url).then(() => toast('Tracking link copied'));
  }
}

function headline(o: any): string {
  switch (o.status) {
    case 'AWAITING_PAYMENT': return 'Almost there';
    case 'PAID':
    case 'OFFERED': return 'Finding a driver near the pickup';
    case 'ASSIGNED':
    case 'EN_ROUTE_TO_PICKUP': return `${o.driver?.name?.split(' ')[0] ?? 'Your driver'} is heading to the pickup`;
    case 'PICKED_UP':
    case 'EN_ROUTE_TO_DROPOFF': return `On the way to ${o.receiverName}`;
    case 'DELIVERED': return 'Delivered';
    case 'RETURNING': return 'Returning to sender';
    case 'RETURNED': return 'Returned to sender';
    case 'CANCELLED': return 'Cancelled';
    case 'EXPIRED': return 'This order expired';
    default: return o.status;
  }
}

function Shell({ children, refId }: { children: React.ReactNode; refId?: string }) {
  return (
    <>
      <header className="topbar" style={{ justifyContent: 'space-between' }}>
        <Logo size={26} />
        {refId && <span className="mono muted" style={{ fontSize: 13 }}>{refId}</span>}
      </header>
      <main style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px 48px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div />
        {children}
      </main>
    </>
  );
}
