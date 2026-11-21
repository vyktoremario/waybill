'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Inbox, LogOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Logo } from '@/components/Brand';
import { Skeleton, useToast } from '@/components/Toast';
import { ApiError, DISPATCH_TOKEN_KEY, api, readDispatchToken } from '@/lib/api';
import { ABUJA_CENTER } from '@/lib/places';
import { useRealtime } from '@/lib/realtime';
import { EVENT_LABEL, STATUS_LABEL, fmtTime, naira, shortRef } from '@/lib/status';
import type { MapPoint } from '@/components/LiveMap';

const LiveMap = dynamic(() => import('@/components/LiveMap').then((m) => m.LiveMap), { ssr: false });

type Tab = 'needs' | 'active' | 'issues' | 'done';
const NEEDS = ['PAID', 'OFFERED'];
const ACTIVE = ['ASSIGNED', 'EN_ROUTE_TO_PICKUP', 'PICKED_UP', 'EN_ROUTE_TO_DROPOFF', 'RETURNING'];
const DRIVER_COLOR: Record<string, string> = { available: '#15803d', busy: '#0e1116', offline: '#aeb5c0' };

export default function DispatchPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('needs');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const toast = useToast();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = readDispatchToken();
    if (!t) router.replace('/dispatch/login');
    else setToken(t);
  }, [router]);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      try {
        return await api(path, { ...init, token });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          try {
            localStorage.removeItem(DISPATCH_TOKEN_KEY);
          } catch {}
          router.replace('/dispatch/login');
        }
        throw e;
      }
    },
    [token, router],
  );

  const loadAll = useCallback(async () => {
    if (!token) return;
    const [o, d, h] = await Promise.all([call('/dispatch/orders'), call('/dispatch/drivers'), call('/dispatch/health')]);
    setOrders(o);
    setDrivers(d);
    setHealth(h);
    setLoaded(true);
  }, [token, call]);

  const loadDetail = useCallback(async () => {
    if (!token || !selected) return setDetail(null);
    setDetail(await call(`/dispatch/orders/${selected}`));
  }, [token, selected, call]);

  useEffect(() => {
    void loadAll().catch(() => undefined);
    const t = setInterval(() => {
      setNow(Date.now());
      void call('/dispatch/health').then(setHealth).catch(() => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, [loadAll, call]);

  useEffect(() => {
    void loadDetail().catch(() => undefined);
  }, [loadDetail]);

  const conn = useRealtime({
    auth: token ? { token } : null,
    rooms: ['dispatch'],
    onResync: () => void loadAll().catch(() => undefined),
    onMessage: (msg) => {
      if (msg.type === 'location') {
        setDrivers((ds) => ds.map((d) => (d.id === msg.driverId ? { ...d, lat: msg.lat, lng: msg.lng, last_seen_at: msg.recordedAt } : d)));
      } else {
        // Status changes, offers, driver availability: refetch the lists (cheap) so nothing drifts.
        void loadAll().catch(() => undefined);
        if (msg.orderId && msg.orderId === selected) void loadDetail().catch(() => undefined);
      }
    },
  });

  const tabs = useMemo(() => {
    const issue = (o: any) => o.needs_attention || (NEEDS.includes(o.status) && o.paid_at && now - new Date(o.paid_at).getTime() > 10 * 60_000) || o.status === 'RETURNED';
    return {
      needs: orders.filter((o) => NEEDS.includes(o.status)),
      active: orders.filter((o) => ACTIVE.includes(o.status)),
      issues: orders.filter(issue),
      done: orders.filter((o) => ['DELIVERED', 'CANCELLED', 'EXPIRED', 'RETURNED', 'AWAITING_PAYMENT'].includes(o.status)),
    };
  }, [orders, now]);

  const sel = detail?.order;
  const points: MapPoint[] = [
    ...drivers.filter((d) => d.lat != null && d.status !== 'offline').map((d) => ({ id: `d:${d.id}`, kind: 'driver' as const, lat: d.lat, lng: d.lng, color: sel?.driver_id === d.id ? '#1d4ed8' : DRIVER_COLOR[d.status], label: `${d.name} · ${d.status}` })),
    ...(sel ? [
      { id: 'pickup', kind: 'pickup' as const, lat: sel.pickup_lat, lng: sel.pickup_lng, label: 'Pickup' },
      { id: 'dropoff', kind: 'dropoff' as const, lat: sel.dropoff_lat, lng: sel.dropoff_lng, label: 'Drop-off' },
    ] : []),
  ];

  async function act(path: string, body: unknown = {}, done?: string) {
    setError(null);
    try {
      setDetail(await call(path, { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), ...(body as object) }) }));
      await loadAll();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, 'error');
    }
  }

  // Keyboard: j / k (or arrow keys) move through the queue, Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, dialog') || e.metaKey || e.ctrlKey) return;
      const items = tabs[tab];
      if (!items.length) return;
      const i = items.findIndex((o) => o.id === selected);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = items[Math.min(items.length - 1, i + 1)]!;
        setSelected(next.id);
        listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)?.focus();
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = items[Math.max(0, i - 1)]!;
        setSelected(prev.id);
        listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${prev.id}"]`)?.focus();
      } else if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, tab, selected]);

  if (!token) return null;
  const list = tabs[tab];
  const available = drivers.filter((d) => d.status === 'available');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="topbar">
        <Logo href="/dispatch" size={28} label="Dispatch · Abuja" />
        <span className="chip chip-neutral"><span style={{ width: 8, height: 8, borderRadius: '50%', background: conn === 'live' ? 'var(--done)' : 'var(--attention)' }} />{conn === 'live' ? 'Live' : 'Reconnecting'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <span className={`chip ${health?.outbox?.waiting > 0 ? 'chip-attention' : 'chip-neutral'} mono`}>Outbox {health?.outbox?.waiting ?? '–'} waiting{health?.outbox?.waiting > 0 ? ` · oldest ${health.outbox.oldest_seconds}s` : ''}</span>
          <span className={`chip ${health?.deadLetters > 0 ? 'chip-problem' : 'chip-neutral'} mono`}>Dead letters {health?.deadLetters ?? '–'}</span>
          <span className="chip chip-neutral mono">Drivers {drivers.filter((d) => d.status !== 'offline').length} online</span>
          <button className="btn btn-small btn-secondary" onClick={() => { try { localStorage.removeItem(DISPATCH_TOKEN_KEY); } catch {} router.replace('/dispatch/login'); }}><LogOut size={14} aria-hidden="true" />Sign out</button>
        </div>
      </header>

      <div className="kpis" aria-label="Today at a glance">
        <Kpi label="Waiting for a driver" value={!loaded ? '–' : tabs.needs.length} attention={tabs.needs.some((o) => o.needs_attention)} />
        <Kpi label="Out for delivery" value={!loaded ? '–' : tabs.active.length} />
        <Kpi label="Needs attention" value={!loaded ? '–' : tabs.issues.length} attention={tabs.issues.length > 0} />
        <Kpi label="Delivered today" value={!loaded ? '–' : orders.filter((o) => o.status === 'DELIVERED' && new Date(o.updated_at).toDateString() === new Date().toDateString()).length} />
        <Kpi label="Drivers available" value={!loaded ? '–' : available.length} />
        <div className="kpi" style={{ justifyContent: 'center', fontSize: 12, color: 'var(--muted)' }}>
          <span><span className="kbd">j</span> <span className="kbd">k</span> move · <span className="kbd">Esc</span> clear</span>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <section aria-label="Order queue" style={{ flex: '1 1 320px', maxWidth: 420, minWidth: 0, background: 'var(--surface)', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column' }}>
          <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
            {(['needs', 'active', 'issues', 'done'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="btn btn-small" style={{ border: 0, background: tab === t ? 'var(--ink)' : t === 'issues' && tabs.issues.length ? 'var(--attention-soft)' : 'transparent', color: tab === t ? '#fff' : t === 'issues' && tabs.issues.length ? 'var(--attention-ink)' : 'var(--ink)' }}>
                {{ needs: 'Needs driver', active: 'Active', issues: 'Issues', done: 'Other' }[t]} {tabs[t].length}
              </button>
            ))}
          </div>
          <div ref={listRef} style={{ overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
            {!loaded && [0, 1, 2, 3].map((i) => (
              <div key={i} style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--line-soft)' }}>
                <Skeleton h={12} w="40%" /><Skeleton h={16} w="70%" /><Skeleton h={22} w={110} r={999} />
              </div>
            ))}
            {loaded && list.length === 0 && (
              <div className="fade-in" style={{ padding: '40px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
                <span className="step-icon"><Inbox size={22} aria-hidden="true" /></span>
                <strong>{tab === 'needs' ? 'Every paid order has a driver' : tab === 'issues' ? 'Nothing needs attention' : tab === 'active' ? 'No deliveries on the road' : 'No other orders yet'}</strong>
                <span className="muted" style={{ fontSize: 14 }}>New orders appear here as soon as they are paid.</span>
              </div>
            )}
            {list.map((o) => {
              const s = STATUS_LABEL[o.status]!;
              const waited = o.paid_at ? Math.floor((now - new Date(o.paid_at).getTime()) / 60_000) : null;
              const offerLeft = o.pending_offer ? Math.max(0, Math.round((new Date(o.pending_offer.expiresAt).getTime() - now) / 1000)) : null;
              return (
                <button key={o.id} data-id={o.id} className="queue-row" aria-current={selected === o.id ? 'true' : undefined} onClick={() => setSelected(o.id)} style={{ width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 16px', border: 0, borderBottom: '1px solid var(--line-soft)', borderLeft: `4px solid ${selected === o.id ? 'var(--cobalt)' : 'transparent'}`, background: selected === o.id ? 'var(--cobalt-tint)' : 'transparent', color: 'var(--ink)' }}>
                  <span style={{ display: 'flex', gap: 8 }}><span className="mono" style={{ fontSize: 13 }}>{shortRef(o.id)}</span><span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{waited != null ? `paid ${waited} min ago` : `created ${fmtTime(o.created_at)}`}</span></span>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{area(o.pickup_address)} → {area(o.dropoff_address)}</span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <span className={`chip chip-${s.tone}`}>{s.dispatch}{offerLeft != null ? ` · ${offerLeft} s` : ''}</span>
                    {o.needs_attention && <span className="chip chip-attention">No driver for 10+ min</span>}
                    <span className="muted" style={{ fontSize: 12 }}>{o.package_size}{o.driver_name ? ` · ${o.driver_name}` : ''}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-label="Live map" style={{ flex: '999 1 480px', minWidth: 0, minHeight: 480, position: 'relative' }}>
          <LiveMap points={points} center={ABUJA_CENTER} fitTo={sel ? ['pickup', 'dropoff', ...(sel.driver_id ? [`d:${sel.driver_id}`] : [])] : undefined} onSelect={() => undefined} />
          <div className="card" style={{ position: 'absolute', left: 16, bottom: 16, padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, fontWeight: 600 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: DRIVER_COLOR.available }} />Available</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: DRIVER_COLOR.busy }} />On a job</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--cobalt)' }} />Selected order's driver</span>
          </div>
        </section>

        <aside aria-label="Selected order" style={{ flex: '1 1 320px', maxWidth: 400, minWidth: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', padding: 20, display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', maxHeight: 'calc(100vh - 64px)' }}>
          {!sel && <p className="muted">Select an order to see its timeline and act on it.</p>}
          {sel && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="mono muted" style={{ fontSize: 13 }}>{shortRef(sel.id)} · {naira(sel.price_kobo)}</span>
                <h2 style={{ fontSize: 22 }}>{area(sel.pickup_address)} → {area(sel.dropoff_address)}</h2>
                <span style={{ fontSize: 14, color: 'var(--ink-2)' }}>{sel.item} · {sel.package_size} · {(sel.distance_meters / 1000).toFixed(1)} km</span>
                <span><span className={`chip chip-${STATUS_LABEL[sel.status]!.tone}`}>{STATUS_LABEL[sel.status]!.dispatch}</span></span>
                {sel.cancel_reason && <span style={{ fontSize: 14 }}>Reason: {sel.cancel_reason}</span>}
              </div>

              {['PAID', 'OFFERED'].includes(sel.status) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h3 className="eyebrow" style={{ color: 'var(--muted)' }}>Assign a driver</h3>
                  {available.length === 0 && <p className="muted" style={{ margin: 0, fontSize: 14 }}>No drivers available right now. The system keeps trying and refunds automatically if nobody takes it.</p>}
                  {available.map((d) => (
                    <div key={d.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
                      <span style={{ display: 'flex', flexDirection: 'column' }}><strong style={{ fontSize: 15 }}>{d.name}</strong><span className="muted" style={{ fontSize: 12 }}>{d.vehicle}{d.lat != null ? ` · ${km(d, sel)} km from pickup` : ''}</span></span>
                      <button className="btn btn-small btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => act(`/dispatch/orders/${sel.id}/assign`, { driverId: d.id }, `Assigned to ${d.name}`)}>Assign</button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 className="eyebrow" style={{ color: 'var(--muted)' }}>Timeline</h3>
                <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
                  {detail.events.map((e: any) => {
                    const late = new Date(e.recorded_at).getTime() - new Date(e.occurred_at).getTime() > 30_000;
                    return (
                      <li key={e.seq} style={{ display: 'flex', gap: 10 }}>
                        <span className="mono muted" style={{ width: 44, fontSize: 12, fontWeight: 500 }}>{fmtTime(e.occurred_at)}</span>
                        <span>{EVENT_LABEL[e.type] ?? e.type}{e.payload?.reason ? `: ${e.payload.reason}` : ''}{late && <span className="muted"> · recorded {fmtTime(e.recorded_at)} (sent while offline)</span>}</span>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <h3 className="eyebrow" style={{ color: 'var(--muted)' }}>Payments</h3>
                {detail.payments.length === 0 && <span className="muted" style={{ fontSize: 14 }}>None yet.</span>}
                {detail.payments.map((p: any) => (
                  <div key={p.id} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' }}>
                    <span className="mono">{p.provider_reference.slice(0, 14)}…</span>
                    <span>{naira(p.amount_kobo)}</span>
                    <span className={`chip ${p.status === 'succeeded' ? 'chip-done' : p.status.startsWith('refund') ? 'chip-attention' : 'chip-neutral'}`}>{p.status.replace('_', ' ')}{p.role === 'extra' ? ' · duplicate' : ''}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(sel.status) && <button className="btn btn-secondary" onClick={() => act(`/dispatch/orders/${sel.id}/unassign`, {}, 'Driver unassigned; finding another')}>Unassign</button>}
                {['AWAITING_PAYMENT', 'PAID', 'OFFERED', 'ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(sel.status) && (
                  <button className="btn btn-secondary" style={{ color: 'var(--problem)', borderColor: 'var(--line)' }} onClick={() => setCancelling(sel.id)}>Cancel &amp; refund</button>
                )}
                {sel.status === 'RETURNED' && !detail.refunds.length && <button className="btn btn-secondary" onClick={() => act(`/dispatch/orders/${sel.id}/refund`, {}, 'Refund started')}>Refund customer</button>}
              </div>
              {error && <div className="banner banner-problem" role="alert">{error}</div>}
            </>
          )}
        </aside>
      </div>
      {cancelling && (
        <CancelDialog
          onClose={() => setCancelling(null)}
          onConfirm={(reason) => {
            const id = cancelling;
            setCancelling(null);
            void act(`/dispatch/orders/${id}/cancel`, { reason }, 'Order cancelled; refund started');
          }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, attention }: { label: string; value: number | string; attention?: boolean }) {
  return (
    <div className={`kpi ${attention ? 'kpi-attention' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
}

const REASONS = ['Customer asked to cancel', 'Pickup address unreachable', 'Parcel not allowed', 'Duplicate order'];

/** Cancelling refunds the customer and they see the reason, so it gets a proper confirmation. */
function CancelDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="cancel-title">
      <form
        className="modal-body"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onConfirm(reason.trim());
        }}
      >
        <h2 id="cancel-title" style={{ fontSize: 22 }}>Cancel and refund this order?</h2>
        <p className="muted" style={{ margin: 0 }}>If the customer paid, the full amount goes back to them. The driver, if any, is released. The customer sees the reason.</p>
        <div className="reason-chips" role="group" aria-label="Common reasons">
          {REASONS.map((r) => (
            <button type="button" key={r} aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="reason">Reason</label>
          <textarea id="reason" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => ref.current?.close()}>Keep order</button>
          <button className="btn btn-cta" style={{ background: 'var(--problem)' }} disabled={!reason.trim()}>Cancel &amp; refund</button>
        </div>
      </form>
    </dialog>
  );
}

function area(address: string): string {
  return address.split(',').pop()!.trim();
}

function km(d: { lat: number; lng: number }, o: { pickup_lat: number; pickup_lng: number }): string {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(o.pickup_lat - d.lat);
  const dLng = toRad(o.pickup_lng - d.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(d.lat)) * Math.cos(toRad(o.pickup_lat)) * Math.sin(dLng / 2) ** 2;
  return (2 * R * Math.asin(Math.sqrt(h))).toFixed(1);
}
