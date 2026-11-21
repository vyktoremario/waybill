import { describe, expect, it } from 'vitest';
import { driverEarningKobo, haversineMeters, quoteKobo } from './pricing';

const garki = { lat: 9.0333, lng: 7.4833 };
const wuse2 = { lat: 9.0765, lng: 7.4693 };

describe('pricing', () => {
  it('computes straight-line distance', () => {
    const d = haversineMeters(garki, wuse2);
    expect(d).toBeGreaterThan(4_500);
    expect(d).toBeLessThan(5_300);
  });

  it('quotes integer kobo rounded up to ₦50', () => {
    const { priceKobo } = quoteKobo(garki, wuse2, 'small');
    expect(Number.isInteger(priceKobo)).toBe(true);
    expect(priceKobo % 5_000).toBe(0);
  });

  it('charges more for bigger packages', () => {
    const s = quoteKobo(garki, wuse2, 'small').priceKobo;
    const l = quoteKobo(garki, wuse2, 'large').priceKobo;
    expect(l).toBeGreaterThan(s);
  });

  it('driver earning is an integer and less than the price', () => {
    const p = quoteKobo(garki, wuse2, 'medium').priceKobo;
    const e = driverEarningKobo(p);
    expect(Number.isInteger(e)).toBe(true);
    expect(e).toBeLessThan(p);
  });
});
