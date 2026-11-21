'use client';

import { quoteKobo, type PackageSize } from '@waybill/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ABUJA_AREAS } from '@/lib/places';
import { naira } from '@/lib/status';

const SIZES: Array<{ value: PackageSize; label: string; hint: string }> = [
  { value: 'small', label: 'Small', hint: 'Fits on a bike: documents, phone, food' },
  { value: 'medium', label: 'Medium', hint: 'Needs a car: a box or a few bags' },
  { value: 'large', label: 'Large', hint: 'Needs a van: furniture, many boxes' },
];

export default function BookPage() {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    receiver: '',
    pickupArea: 'Garki',
    pickupStreet: '',
    dropoffArea: 'Wuse 2',
    dropoffStreet: '',
    item: '',
    size: 'small' as PackageSize,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  const pickup = ABUJA_AREAS.find((a) => a.name === form.pickupArea)!;
  const dropoff = ABUJA_AREAS.find((a) => a.name === form.dropoffArea)!;
  const quote = useMemo(() => quoteKobo(pickup, dropoff, form.size), [pickup, dropoff, form.size]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ order: { id: string }; trackingToken: string }>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer: { name: form.name, phone: form.phone, email: form.email },
          receiverName: form.receiver,
          pickup: { address: `${form.pickupStreet}, ${form.pickupArea}`, location: { lat: pickup.lat, lng: pickup.lng } },
          dropoff: { address: `${form.dropoffStreet}, ${form.dropoffArea}`, location: { lat: dropoff.lat, lng: dropoff.lng } },
          item: form.item,
          packageSize: form.size,
        }),
      });
      // One idempotency key per order, so a double click or a retry opens the same checkout.
      const pay = await api<{ checkoutUrl: string }>(`/track/${created.trackingToken}/pay`, {
        method: 'POST',
        headers: { 'idempotency-key': `checkout:${created.order.id}` },
      });
      window.location.href = pay.checkoutUrl;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? 'Please check the highlighted details.' : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">Waybill</Link>
        <span className="muted" style={{ fontSize: 14 }}>Same-day delivery · Abuja</span>
        <Link href="/dispatch" style={{ marginLeft: 'auto', fontSize: 14 }}>Dispatch</Link>
      </header>
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '32px 16px 64px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="eyebrow">Send a parcel</span>
          <h1 style={{ fontSize: 36 }}>Book a delivery</h1>
          <p className="muted" style={{ margin: 0 }}>Pay with Paystack (test mode). You get a tracking link to share with the receiver.</p>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <fieldset className="card" style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <legend className="eyebrow" style={{ padding: '0 6px' }}>From</legend>
            <div className="field"><label htmlFor="pa">Pickup area</label><select id="pa" value={form.pickupArea} onChange={set('pickupArea')}>{ABUJA_AREAS.map((a) => <option key={a.name}>{a.name}</option>)}</select></div>
            <div className="field"><label htmlFor="ps">Street address</label><input id="ps" required minLength={3} value={form.pickupStreet} onChange={set('pickupStreet')} placeholder="12 Ahmadu Bello Way" /></div>
            <div className="field"><label htmlFor="n">Your name</label><input id="n" required value={form.name} onChange={set('name')} autoComplete="name" /></div>
            <div className="field"><label htmlFor="ph">Your phone</label><input id="ph" required type="tel" minLength={7} value={form.phone} onChange={set('phone')} autoComplete="tel" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="em">Email for the receipt</label><input id="em" required type="email" value={form.email} onChange={set('email')} autoComplete="email" /></div>
          </fieldset>

          <fieldset className="card" style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <legend className="eyebrow" style={{ padding: '0 6px' }}>To</legend>
            <div className="field"><label htmlFor="da">Drop-off area</label><select id="da" value={form.dropoffArea} onChange={set('dropoffArea')}>{ABUJA_AREAS.map((a) => <option key={a.name}>{a.name}</option>)}</select></div>
            <div className="field"><label htmlFor="ds">Street address</label><input id="ds" required minLength={3} value={form.dropoffStreet} onChange={set('dropoffStreet')} placeholder="Plot 14, Aminu Kano Crescent" /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="r">Receiver's name</label><input id="r" required value={form.receiver} onChange={set('receiver')} /></div>
          </fieldset>

          <fieldset className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <legend className="eyebrow" style={{ padding: '0 6px' }}>Parcel</legend>
            <div className="field"><label htmlFor="it">What are you sending?</label><input id="it" required value={form.item} onChange={set('item')} placeholder="Documents" /></div>
            <div role="radiogroup" aria-label="Package size" style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {SIZES.map((s) => (
                <label key={s.value} className={form.size === s.value ? 'card-strong' : 'card'} style={{ padding: 14, display: 'flex', gap: 10, cursor: 'pointer' }}>
                  <input type="radio" name="size" value={s.value} checked={form.size === s.value} onChange={() => setForm({ ...form, size: s.value })} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <strong>{s.label}</strong>
                    <span className="field-hint">{s.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="card" style={{ padding: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="muted" style={{ fontSize: 13 }}>Price · {(quote.distanceMeters / 1000).toFixed(1)} km straight-line</span>
              <span className="mono" style={{ fontSize: 28 }}>{naira(quote.priceKobo)}</span>
            </div>
            <button className="btn btn-primary" style={{ marginLeft: 'auto', minWidth: 220 }} disabled={busy}>
              {busy ? 'Opening checkout…' : `Pay ${naira(quote.priceKobo)}`}
            </button>
          </div>
          {error && <div className="banner banner-problem" role="alert">{error}</div>}
        </form>
      </main>
    </>
  );
}
