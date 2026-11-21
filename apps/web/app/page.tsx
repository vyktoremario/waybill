'use client';

import { Camera, Smartphone, Check, CreditCard, Download, MapPin, Package, RotateCcw, ShieldCheck, Truck, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DemoBanner, SiteFooter, SiteHeader } from '@/components/Brand';

/** The latest Android build of the driver app, attached to the newest GitHub Release (stable URL). */
const DRIVER_APK_URL = 'https://github.com/vyktoremario/waybill/releases/latest/download/waybill-driver.apk';

const FAQ = [
  {
    q: 'Is this a real delivery service?',
    a: 'No. Waybill is a portfolio project. Payments run in Paystack test mode with test cards, and no driver will turn up. Everything else (booking, payment, assignment, live tracking, refunds) works end to end.',
  },
  {
    q: 'What happens if no driver accepts my parcel?',
    a: 'Waybill keeps offering it to nearby drivers. If nobody takes it within 20 minutes, the order is cancelled and your payment is refunded automatically.',
  },
  {
    q: 'Why do I need a PIN?',
    a: 'The PIN on your tracking page is the proof of delivery. The driver can only complete the delivery by entering it, so give it to them only when the parcel is in your hands.',
  },
  {
    q: 'When can I see the driver on the map?',
    a: 'From pickup until delivery. Before pickup you see their progress but not their location, which protects drivers between jobs.',
  },
];

export default function Landing() {
  const router = useRouter();
  const [link, setLink] = useState('');
  const [trackError, setTrackError] = useState<string | null>(null);

  function track(e: React.FormEvent) {
    e.preventDefault();
    // Accept a full tracking link or just the token at the end of it.
    const token = link.trim().split('/t/').pop()?.split(/[?#]/)[0]?.trim();
    if (!token || token.length < 10) {
      setTrackError('Paste the tracking link from your booking, e.g. waybill…/t/AbC123…');
      return;
    }
    router.push(`/t/${token}`);
  }

  return (
    <>
      <DemoBanner />
      <SiteHeader />
      <main>
        <section className="container hero">
          <div className="hero-copy">
            <span className="eyebrow-mono">SAME-DAY DELIVERY · ABUJA</span>
            <h1 className="hero-title">Send it across Abuja. Watch it to the door.</h1>
            <p className="hero-lede">Book in a minute and pay with Paystack. Share a live tracking link with whoever is receiving. The driver hands over only when they read out your PIN.</p>
            <div className="hero-actions">
              <Link href="/send" className="btn btn-cta btn-lg">Get a price</Link>
              <Link href="/#how" className="btn btn-secondary btn-lg">How it works</Link>
            </div>
            <ul className="hero-points">
              <li><Check size={18} aria-hidden="true" />Price before you pay</li>
              <li><Check size={18} aria-hidden="true" />Refunded if no driver takes it</li>
              <li><Check size={18} aria-hidden="true" />Live map after pickup</li>
            </ul>
          </div>
          <HeroVisual />
        </section>

        <section id="track" className="band">
          <form className="container track-form" onSubmit={track}>
            <label htmlFor="trk" className="track-label">Track a parcel</label>
            <input id="trk" value={link} onChange={(e) => { setLink(e.target.value); setTrackError(null); }} placeholder="Paste your tracking link" aria-describedby={trackError ? 'trk-err' : undefined} />
            <button className="btn btn-secondary" style={{ minHeight: 50 }}>Track</button>
            {trackError && <p id="trk-err" className="field-error" role="alert">{trackError}</p>}
          </form>
        </section>

        <section id="how" className="container section">
          <div className="section-head">
            <span className="eyebrow-mono">HOW IT WORKS</span>
            <h2 className="section-title">Three steps, one link to share</h2>
          </div>
          <ol className="steps-grid">
            <Step n="01" icon={<CreditCard size={22} aria-hidden="true" />} title="Book and pay">Choose pickup and drop-off, pick a parcel size, and see the price before you pay with Paystack.</Step>
            <Step n="02" icon={<Truck size={22} aria-hidden="true" />} title="A nearby driver takes it">The closest driver with the right vehicle gets the job, and photographs the parcel at pickup.</Step>
            <Step n="03" icon={<MapPin size={22} aria-hidden="true" />} title="Track and hand over">The receiver follows the driver live and gives the 4-digit PIN at the door. That confirms delivery.</Step>
          </ol>
        </section>

        <section className="dark-band">
          <div className="container section">
            <h2 className="section-title" style={{ maxWidth: 720 }}>If something goes wrong, your money doesn&apos;t get lost with it</h2>
            <div className="promise-grid">
              <Promise icon={<RotateCcw size={22} aria-hidden="true" />} title="No driver? Refunded.">If nobody takes your parcel within 20 minutes, the order is cancelled and refunded automatically.</Promise>
              <Promise icon={<ShieldCheck size={22} aria-hidden="true" />} title="Paid twice? Refunded.">Opened checkout in two tabs and paid both? The extra payment goes back by itself.</Promise>
              <Promise icon={<WifiOff size={22} aria-hidden="true" />} title="Patchy network? Still delivered.">The driver app keeps working without signal and syncs when it&apos;s back.</Promise>
            </div>
          </div>
        </section>

        <section id="riders" className="container section riders">
          <div className="riders-copy">
            <span className="eyebrow-mono">FOR DISPATCH RIDERS</span>
            <h2 className="section-title">Are you a dispatch rider?</h2>
            <p className="muted-lg">Get paid jobs near you with the price shown before you accept. The app walks you through each delivery step by step, and keeps working when the network drops: every step is saved on your phone and synced when you&apos;re back online.</p>
            <ul className="rider-points">
              <li><MapPin size={18} aria-hidden="true" />Jobs near you, matched to your bike, car or van</li>
              <li><WifiOff size={18} aria-hidden="true" />Works without signal, syncs later</li>
              <li><Camera size={18} aria-hidden="true" />Photo at pickup, PIN at the door: no disputes</li>
            </ul>
            <div className="rider-actions">
              <a className="btn btn-cta btn-lg" href={DRIVER_APK_URL} download>
                <Download size={20} aria-hidden="true" />Download for Android
              </a>
              <span className="field-hint">Android 8 or later. When your phone asks, allow your browser to install apps.</span>
            </div>
            <p className="rider-ios"><Smartphone size={16} aria-hidden="true" />iPhone: not available yet. Installing outside the App Store needs Apple&apos;s TestFlight, which this demo doesn&apos;t use.</p>
            <div className="card rider-demo">
              <strong>Try it with a demo rider account</strong>
              <span>Email <code>halima@drivers.waybill.test</code> · password <code>waybill-demo</code></span>
              <span className="field-hint">Go available in the app, then book a delivery here and watch the offer arrive.</span>
            </div>
          </div>
          <figure className="rider-phone">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/img/driver-app-delivery.webp" alt="The Waybill driver app during a delivery: the pickup address, a map, the delivery steps and a Start trip button" width={560} height={950} />
            <figcaption className="field-hint">Shown on iPhone. On Android the map is replaced by the distance for now.</figcaption>
          </figure>
        </section>

        <section id="pricing" className="container section pricing">
          <div className="pricing-copy">
            <span className="eyebrow-mono">PRICING</span>
            <h2 className="section-title">₦1,500 + ₦300 per km</h2>
            <p className="muted-lg">Measured in a straight line between pickup and drop-off, times the parcel size, rounded up to the nearest ₦50. You see the exact price before you pay.</p>
            <Link href="/send" className="btn btn-cta" style={{ alignSelf: 'flex-start' }}>Get your price</Link>
          </div>
          <table className="price-table">
            <caption className="sr-only">Price multiplier by parcel size</caption>
            <thead><tr><th scope="col">Size</th><th scope="col">Carried by</th><th scope="col" className="num">× price</th></tr></thead>
            <tbody>
              <tr><th scope="row"><Package size={16} aria-hidden="true" /> Small</th><td>Bike, car or van</td><td className="num mono">1.0</td></tr>
              <tr><th scope="row"><Package size={18} aria-hidden="true" /> Medium</th><td>Car or van</td><td className="num mono">1.3</td></tr>
              <tr><th scope="row"><Package size={20} aria-hidden="true" /> Large</th><td>Van</td><td className="num mono">1.8</td></tr>
            </tbody>
          </table>
        </section>

        <section id="faq" className="container section">
          <div className="section-head">
            <span className="eyebrow-mono">FAQ</span>
            <h2 className="section-title">Questions</h2>
          </div>
          <div className="faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Step({ n, icon, title, children }: { n: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="step-card">
      <span className="step-top"><span className="step-icon">{icon}</span><span className="mono muted">{n}</span></span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Promise({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="promise">
      <span className="promise-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

/** An illustration of the tracking page over a stylised map (decorative; the real map is MapLibre). */
function HeroVisual() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <div className="hero-map">
        <svg width="100%" height="100%" viewBox="0 0 500 420" preserveAspectRatio="xMidYMid slice" fill="none">
          <path d="M0 90 H500 M0 250 H500 M0 360 H500 M110 0 V420 M300 0 V420 M420 0 V420" stroke="#fff" strokeWidth="12" />
          <path d="M0 400 L500 60" stroke="#fff" strokeWidth="20" />
          <path className="hero-route" d="M120 320 C 180 300, 220 230, 300 210 S 400 120, 420 90" stroke="#1D4ED8" strokeWidth="6" strokeLinecap="round" />
        </svg>
        <span className="hero-pin hero-pin-pickup" />
        <span className="hero-pin hero-pin-driver" />
        <span className="hero-pin hero-pin-drop" />
      </div>
      <div className="hero-card">
        <span className="eyebrow">On the way to you</span>
        <strong className="hero-card-title">About 12 min away</strong>
        <span className="muted" style={{ fontSize: 13 }}>Delivery PIN</span>
        <div className="pin pin-sm"><span>4</span><span>8</span><span>1</span><span>7</span></div>
      </div>
    </div>
  );
}
