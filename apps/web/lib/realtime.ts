'use client';

import { useEffect, useRef, useState } from 'react';
import { REALTIME_URL } from './api';

export type ConnState = 'connecting' | 'live' | 'reconnecting';

/**
 * WebSocket client (ADR-0003). Reconnects with jittered backoff, re-joins its rooms, and calls onResync on
 * every (re)connect so the page refetches a snapshot. Dropped connections are routine (serverless max duration).
 */
export function useRealtime(opts: {
  auth: { token?: string | null; tracking?: string | null } | null;
  rooms: string[];
  onMessage: (msg: any) => void;
  onResync: () => void;
}): ConnState {
  const [state, setState] = useState<ConnState>('connecting');
  const handlers = useRef(opts);
  handlers.current = opts;
  const roomsKey = opts.rooms.join(',');
  const authKey = opts.auth ? `${opts.auth.token ?? ''}|${opts.auth.tracking ?? ''}` : '';

  useEffect(() => {
    if (!opts.auth) return;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const q = new URLSearchParams();
      if (opts.auth?.token) q.set('token', opts.auth.token);
      if (opts.auth?.tracking) q.set('tracking', opts.auth.tracking);
      ws = new WebSocket(`${REALTIME_URL}?${q}`);
      ws.onopen = () => {
        attempt = 0;
        setState('live');
        for (const room of roomsKey.split(',').filter(Boolean)) ws?.send(JSON.stringify({ type: 'join', room }));
        handlers.current.onResync();
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type !== 'joined') handlers.current.onMessage(msg);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setState('reconnecting');
        const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey, authKey]);

  return state;
}
