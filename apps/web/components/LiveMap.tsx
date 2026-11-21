'use client';

import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, Marker } from 'maplibre-gl';
import { useEffect, useRef } from 'react';

maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  kind: 'driver' | 'pickup' | 'dropoff';
  color?: string;
  label?: string;
}

/**
 * MapLibre on OpenFreeMap tiles (no API key). Markers are diffed by id so live updates just move them.
 */
export function LiveMap({ points, center, zoom = 12, fitTo, onSelect }: { points: MapPoint[]; center: { lat: number; lng: number }; zoom?: number; fitTo?: string[]; onSelect?: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [center.lng, center.lat],
      zoom,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;
    return () => {
      map.current?.remove();
      map.current = null;
      markers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const p of points) {
      seen.add(p.id);
      let mk = markers.current.get(p.id);
      if (!mk) {
        const node = document.createElement('div');
        node.className = `marker-${p.kind}`;
        if (p.kind === 'driver') node.style.background = p.color ?? '#1d4ed8';
        if (p.label) {
          node.title = p.label;
          node.setAttribute('aria-label', p.label);
        }
        if (selectRef.current) node.addEventListener('click', () => selectRef.current?.(p.id));
        const created = new maplibregl.Marker({ element: node }).setLngLat([p.lng, p.lat]).addTo(m);
        markers.current.set(p.id, created);
      } else {
        glide(mk, p.lng, p.lat);
        const node = mk.getElement();
        if (p.kind === 'driver') node.style.background = p.color ?? '#1d4ed8';
        if (p.label) node.title = p.label;
      }
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.remove();
        markers.current.delete(id);
      }
    }
  }, [points]);

  const fitKey = (fitTo ?? []).join(',');
  useEffect(() => {
    const m = map.current;
    if (!m || !fitTo?.length) return;
    const pts = points.filter((p) => fitTo.includes(p.id));
    if (pts.length === 0) return;
    if (pts.length === 1) {
      m.easeTo({ center: [pts[0]!.lng, pts[0]!.lat], zoom: 14 });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    for (const p of pts) b.extend([p.lng, p.lat]);
    m.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={el} className="map" role="img" aria-label="Map" />;
}

/** Moves a marker smoothly to its new position (live updates arrive every few seconds). */
function glide(mk: Marker, lng: number, lat: number) {
  const from = mk.getLngLat();
  if (Math.abs(from.lng - lng) < 1e-7 && Math.abs(from.lat - lat) < 1e-7) return;
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const dist = Math.hypot(from.lng - lng, from.lat - lat);
  if (reduce || dist > 0.05) {
    mk.setLngLat([lng, lat]); // big jumps (e.g. a resync) snap instead of sliding across town
    return;
  }
  const start = performance.now();
  const ms = 900;
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / ms);
    const e = 1 - (1 - k) ** 3;
    mk.setLngLat([from.lng + (lng - from.lng) * e, from.lat + (lat - from.lat) * e]);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
