'use client';

import { quoteKobo, type PackageSize } from '@waybill/shared';
import { Bike, Car, Lock, MapPin, Package, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DemoBanner, SiteFooter, SiteHeader } from '@/components/Brand';
import { useToast } from '@/components/Toast';
import { api, ApiError } from '@/lib/api';
import { ABUJA_AREAS } from '@/lib/places';
import { naira } from '@/lib/status';

const SIZES: Array<{ value: PackageSize; label: string; hint: string; icon: React.ReactNode; mult: number }> = [
  { value: 'small', label: 'Small', hint: 'Documents, phone, food. Fits on a bike.', icon: <Bike size={22} aria-hidden="true" />, mult: 1 },
  { value: 'medium', label: 'Medium', hint: 'A box or a few bags. Needs a car.', icon: <Car size={22} aria-hidden="true" />, mult: 1.3 },
  { value: 'large', label: 'Large', hint: 'Furniture, many boxes. Needs a van.', icon: <Truck size={22} aria-hidden="true" />, mult: 1.8 },
];

export default function SendPage() {
  const toast = useToast();
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
  const km = quote.distanceMeters / 1000;
  const size = SIZES.find((s) => s.value === form.size)!;
  const same = form.pickupArea === form.dropoffArea;

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
      toast('Order created. Opening secure checkout…');
      window.location.href = pay.checkoutUrl;
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 400 ? 'Some details look wrong. Check the fields and try again.' : (err as Error).message;
      setError(msg);
      toast(msg, 'error');
      setBusy(false);
    }
  }

  return (
    <>
      <DemoBanner />
      <SiteHeader minimal />
      <main className="container" style={{ paddingTop: 24, paddingBottom: 80 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 28 }}>
          <span className="eyebrow-mono">SEND A PARCEL</span>
          <h1 style={{ fontSize: 'clamp(30px, 4vw, 42px)' }}>Where is it going?</h1>
          <p className="muted-lg">You get a tracking link to share with the receiver as soon as you pay.</p>
        </div>

        <form onSubmit={submit} className="send-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
            <fieldset className="card form-card">
              <legend className="form-legend"><span className="legend-dot legend-pickup" aria-hidden="true" />Pickup</legend>
              <div className="field"><label htmlFor="pa">Area</label><select id="pa" value={form.pickupArea} onChange={set('pickupArea')}>{ABUJA_AREAS.map((a) => <option key={a.name}>{a.name}</option>)}</select></div>
              <div className="field"><label htmlFor="ps">Street address</label><input id="ps" required minLength={3} value={form.pickupStreet} onChange={set('pickupStreet')} placeholder="12 Ahmadu Bello Way" autoComplete="address-line1" /></div>
              <div className="field"><label htmlFor="n">Your name</label><input id="n" required value={form.name} onChange={set('name')} autoComplete="name" /></div>
              <div className="field"><label htmlFor="ph">Your phone</label><input id="ph" required type="tel" minLength={7} value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="0801 234 5678" /></div>
              <div className="field span-2"><label htmlFor="em">Email for the receipt</label><input id="em" required type="email" value={form.email} onChange={set('email')} autoComplete="email" /></div>
            </fieldset>

            <fieldset className="card form-card">
              <legend className="form-legend"><span className="legend-dot legend-drop" aria-hidden="true" />Drop-off</legend>
              <div className="field"><label htmlFor="da">Area</label><select id="da" value={form.dropoffArea} onChange={set('dropoffArea')}>{ABUJA_AREAS.map((a) => <option key={a.name}>{a.name}</option>)}</select></div>
              <div className="field"><label htmlFor="ds">Street address</label><input id="ds" required minLength={3} value={form.dropoffStreet} onChange={set('dropoffStreet')} placeholder="Plot 14, Aminu Kano Crescent" /></div>
              <div className="field span-2"><label htmlFor="r">Receiver&apos;s name</label><input id="r" required value={form.receiver} onChange={set('receiver')} /><span className="field-hint">They&apos;ll need the PIN from the tracking link to receive it.</span></div>
            </fieldset>

            <fieldset className="card form-card" style={{ display: 'flex', flexDirection: 'column' }}>
              <legend className="form-legend"><Package size={18} aria-hidden="true" />Parcel</legend>
              <div className="field"><label htmlFor="it">What are you sending?</label><input id="it" required value={form.item} onChange={set('item')} placeholder="Documents" /></div>
              <div role="radiogroup" aria-label="Parcel size" className="size-grid">
                {SIZES.map((s) => (
                  <label key={s.value} className={`size-option ${form.size === s.value ? 'is-selected' : ''}`}>
                    <input type="radio" name="size" value={s.value} checked={form.size === s.value} onChange={() => setForm({ ...form, size: s.value })} className="sr-only" />
                    <span className="size-icon">{s.icon}</span>
                    <strong>{s.label}</strong>
                    <span className="field-hint">{s.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <aside className="summary" aria-label="Price summary">
            <div className="card summary-card">
              <div className="route-mini">
                <span><span className="legend-dot legend-pickup" aria-hidden="true" />{form.pickupArea}</span>
                <span className="route-line" aria-hidden="true" />
                <span><MapPin size={16} aria-hidden="true" />{form.dropoffArea}</span>
              </div>
              <dl className="breakdown">
                <div><dt>Base</dt><dd className="mono">₦1,500</dd></div>
                <div><dt>{km.toFixed(1)} km × ₦300</dt><dd className="mono">{naira(Math.round(km * 300) * 100)}</dd></div>
                <div><dt>{size.label} parcel</dt><dd className="mono">× {size.mult.toFixed(1)}</dd></div>
                <div className="breakdown-total"><dt>Total</dt><dd className="mono">{naira(quote.priceKobo)}</dd></div>
              </dl>
              <p className="field-hint" style={{ margin: 0 }}>
                {same ? 'Same area: base price times the size, since both ends share a centre point.' : 'Distance is measured in a straight line. The total is rounded up to the nearest ₦50.'}
              </p>
              <button className="btn btn-primary" disabled={busy}>{busy ? 'Opening checkout…' : `Pay ${naira(quote.priceKobo)}`}</button>
              <span className="secure-note"><Lock size={14} aria-hidden="true" />Secure checkout by Paystack · test mode</span>
              {error && <div className="banner banner-problem" role="alert">{error}</div>}
            </div>
          </aside>
        </form>
      </main>
      <SiteFooter />
    </>
  );
}
