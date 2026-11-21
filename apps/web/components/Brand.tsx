import Link from 'next/link';

/** The Waybill mark: a pickup square, a route folded into a W, and a drop-off ring. */
export function Mark({ size = 32, inverted = false }: { size?: number; inverted?: boolean }) {
  const bg = inverted ? '#FFFFFF' : '#0E1116';
  const fg = inverted ? '#0E1116' : '#FFFFFF';
  const ring = inverted ? '#1D4ED8' : '#5B8CFF';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="12" fill={bg} />
      <rect x="8.5" y="12.5" width="6" height="6" rx="1.5" fill={fg} />
      <path d="M11.5 19 L17.5 35 L24 23 L30.5 35 L35.8 21.2" stroke={fg} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="36.5" cy="15.5" r="3.6" stroke={ring} strokeWidth="2.6" />
    </svg>
  );
}

export function Logo({ href = '/', size = 30, label }: { href?: string; size?: number; label?: string }) {
  return (
    <Link href={href} className="logo" aria-label="Waybill home">
      <Mark size={size} />
      <span className="logo-word">Waybill</span>
      {label && <span className="logo-label">{label}</span>}
    </Link>
  );
}

export function DemoBanner() {
  return <div className="demo-banner">Portfolio project · Paystack test mode, so no real money moves and no real deliveries are made</div>;
}

export function SiteHeader({ minimal = false }: { minimal?: boolean }) {
  return (
    <header className="site-header">
      <div className="container site-header-row">
        <Logo />
        {!minimal && (
          <nav aria-label="Main" className="site-nav">
            <Link href="/#how">How it works</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/#riders">For riders</Link>
            <Link href="/#faq">FAQ</Link>
          </nav>
        )}
        <div className="site-header-actions">
          <Link href="/#track" className="btn btn-secondary">Track a parcel</Link>
          <Link href="/send" className="btn btn-cta">Send a parcel</Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer-row">
        <Logo size={24} />
        <span>A portfolio project. Payments run in Paystack test mode.</span>
        <span className="site-footer-links">
          <a href="https://github.com/vyktoremario/waybill">Source on GitHub</a>
          <Link href="/dispatch">Dispatch sign-in</Link>
        </span>
      </div>
    </footer>
  );
}
