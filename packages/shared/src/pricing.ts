import type { LatLng, PackageSize } from './schemas';

/** Great-circle distance in metres. The quote uses straight-line distance, labelled as such in the UI. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Prices are in kobo (₦1 = 100 kobo) and are integers everywhere.
const BASE_KOBO = 1_500_00;
const PER_KM_KOBO = 300_00;
const SIZE_MULTIPLIER: Record<PackageSize, number> = { small: 1, medium: 1.3, large: 1.8 };
/** Share of the price credited to the driver; the rest is the platform fee. */
export const DRIVER_SHARE = 0.7;

export function quoteKobo(pickup: LatLng, dropoff: LatLng, size: PackageSize): { priceKobo: number; distanceMeters: number } {
  const distanceMeters = Math.round(haversineMeters(pickup, dropoff));
  const raw = (BASE_KOBO + (PER_KM_KOBO * distanceMeters) / 1000) * SIZE_MULTIPLIER[size];
  // Round up to the nearest ₦50.
  const priceKobo = Math.ceil(raw / 50_00) * 50_00;
  return { priceKobo, distanceMeters };
}

export function driverEarningKobo(priceKobo: number): number {
  return Math.floor(priceKobo * DRIVER_SHARE);
}

export function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}
