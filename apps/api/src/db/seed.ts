import { uuidv7 } from 'uuidv7';
import { loadConfig } from '../config';
import { hashPassword } from '../crypto';
import { createPool, point } from './db';
import { migrate } from './migrate';

/**
 * Demo accounts (sample data, not real people). Password for all: "waybill-demo".
 * Driver positions are spread around central Abuja.
 */
export const DEMO_PASSWORD = 'waybill-demo';
export const DEMO_DRIVERS = [
  { name: 'Musa Abubakar', email: 'musa@drivers.waybill.test', vehicle: 'car', lat: 9.0579, lng: 7.4951 },
  { name: 'Ifeoma Nwosu', email: 'ifeoma@drivers.waybill.test', vehicle: 'van', lat: 9.0643, lng: 7.4892 },
  { name: 'Ade Kolawole', email: 'ade@drivers.waybill.test', vehicle: 'bike', lat: 9.0412, lng: 7.4791 },
  { name: 'Halima Yusuf', email: 'halima@drivers.waybill.test', vehicle: 'bike', lat: 9.0811, lng: 7.4665 },
  { name: 'Tunde Bakare', email: 'tunde@drivers.waybill.test', vehicle: 'car', lat: 9.0257, lng: 7.4521 },
] as const;

export async function seed(databaseUrl: string): Promise<void> {
  const db = createPool(databaseUrl);
  try {
    const pw = hashPassword(DEMO_PASSWORD);
    await db.query(
      `INSERT INTO users (id, role, name, email, password_hash) VALUES ($1, 'dispatcher', 'Dispatch Desk', 'dispatch@waybill.test', $2)
       ON CONFLICT (email) DO NOTHING`,
      [uuidv7(), pw],
    );
    for (const d of DEMO_DRIVERS) {
      const id = (
        await db.query(
          `INSERT INTO users (id, role, name, email, password_hash) VALUES ($1, 'driver', $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [uuidv7(), d.name, d.email, pw],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO drivers (user_id, vehicle, last_location) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
        [id, d.vehicle, point(d.lat, d.lng)],
      );
    }
    console.log(`[seed] dispatcher: dispatch@waybill.test · drivers: ${DEMO_DRIVERS.map((d) => d.email).join(', ')} · password: ${DEMO_PASSWORD}`);
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  const url = loadConfig().databaseUrl;
  migrate(url)
    .then(() => seed(url))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
