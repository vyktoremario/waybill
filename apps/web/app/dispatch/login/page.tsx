'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Mark } from '@/components/Brand';
import { DISPATCH_TOKEN_KEY, api } from '@/lib/api';

export default function DispatchLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: { role: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (r.user.role !== 'dispatcher') throw new Error('This account is not a dispatcher.');
      try {
        localStorage.setItem(DISPATCH_TOKEN_KEY, r.token);
      } catch {
        /* private mode: the session won't survive a reload */
      }
      router.replace('/dispatch');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 380, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Mark size={40} />
          <div>
            <span className="eyebrow">Waybill dispatch</span>
            <h1 style={{ fontSize: 28 }}>Sign in</h1>
          </div>
        </div>
        <div className="field"><label htmlFor="e">Email</label><input id="e" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></div>
        <div className="field"><label htmlFor="p">Password</label><input id="p" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <div className="banner banner-problem" role="alert">{error}</div>}
        <p className="field-hint" style={{ margin: 0 }}>Demo account: dispatch@waybill.test (password in the README).</p>
      </form>
    </main>
  );
}
