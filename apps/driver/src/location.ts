import * as Location from 'expo-location';
import { points } from './store';
import { sync } from './sync';

/**
 * Foreground location while the driver is online (ADR-0003): every 5 s or 25 m. Points always go to the
 * local queue first and are sent in batches by the sync loop, the same way online or offline.
 */
let sub: Location.LocationSubscription | null = null;
let currentOrderId: string | undefined;
type Pos = { lat: number; lng: number; heading?: number };
let lastPos: Pos | null = null;
const posListeners = new Set<(p: Pos) => void>();

/** The UI (the delivery map) listens for the phone's position. */
export function onPosition(fn: (p: Pos) => void): () => void {
  posListeners.add(fn);
  if (lastPos) fn(lastPos);
  return () => {
    posListeners.delete(fn);
  };
}

export function setActiveOrder(orderId: string | undefined) {
  currentOrderId = orderId;
}

export async function startTracking(): Promise<boolean> {
  if (sub) return true;
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return false;
  sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5_000, distanceInterval: 25 }, (loc) => {
    const seq = points.nextSeq();
    points.add(seq, {
      seq,
      recordedAt: new Date(loc.timestamp).toISOString(),
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      accuracy: loc.coords.accuracy ?? undefined,
      speed: loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : undefined,
      heading: loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : undefined,
      orderId: currentOrderId,
    });
    lastPos = { lat: loc.coords.latitude, lng: loc.coords.longitude, heading: loc.coords.heading ?? undefined };
    for (const fn of posListeners) fn(lastPos);
    sync.kick();
  });
  return true;
}

export function stopTracking() {
  sub?.remove();
  sub = null;
}
