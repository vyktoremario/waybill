import { z } from 'zod';
import { ORDER_STATUSES } from './state-machine';

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;

export const PACKAGE_SIZES = ['small', 'medium', 'large'] as const;
export type PackageSize = (typeof PACKAGE_SIZES)[number];
export const VEHICLES = ['bike', 'car', 'van'] as const;
export type Vehicle = (typeof VEHICLES)[number];

/** Which vehicles can carry which package size (bike ⊂ car ⊂ van). */
export const VEHICLES_FOR_SIZE: Record<PackageSize, readonly Vehicle[]> = {
  small: ['bike', 'car', 'van'],
  medium: ['car', 'van'],
  large: ['van'],
};

export const Place = z.object({
  address: z.string().min(3).max(200),
  location: LatLng,
});

export const CreateOrderInput = z.object({
  customer: z.object({
    name: z.string().min(1).max(100),
    phone: z.string().min(7).max(20),
    email: z.email(),
  }),
  receiverName: z.string().min(1).max(100),
  pickup: Place,
  dropoff: Place,
  item: z.string().min(1).max(120),
  packageSize: z.enum(PACKAGE_SIZES),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

export const DRIVER_COMMAND_TYPES = [
  'accept_offer',
  'decline_offer',
  'start_trip',
  'confirm_pickup',
  'start_dropoff',
  'confirm_delivery',
  'report_failed_attempt',
  'confirm_return',
] as const;
export type DriverCommandType = (typeof DRIVER_COMMAND_TYPES)[number];

export const DriverCommand = z.object({
  commandId: z.uuid(),
  orderId: z.uuid(),
  type: z.enum(DRIVER_COMMAND_TYPES),
  expectedVersion: z.number().int().nonnegative().optional(),
  occurredAt: z.iso.datetime(),
  payload: z
    .object({
      offerId: z.uuid().optional(),
      photoId: z.string().max(100).optional(),
      pin: z.string().regex(/^\d{4}$/).optional(),
      reason: z.string().max(300).optional(),
    })
    .default({}),
});
export type DriverCommand = z.infer<typeof DriverCommand>;

export const LocationPoint = z.object({
  seq: z.number().int().nonnegative(),
  recordedAt: z.iso.datetime(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().max(10_000).optional(),
  speed: z.number().min(0).max(100).optional(),
  heading: z.number().min(0).max(360).optional(),
  orderId: z.uuid().optional(),
});
export type LocationPoint = z.infer<typeof LocationPoint>;

export const LocationBatch = z.object({ points: z.array(LocationPoint).min(1).max(500) });

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

/** Messages pushed to WebSocket clients. */
export type RealtimeMessage =
  | { type: 'location'; driverId: string; orderId?: string; lat: number; lng: number; recordedAt: string; seq: number }
  | { type: 'order'; orderId: string; status: string; version: number; at: string }
  | { type: 'offer'; offerId: string; orderId: string; expiresAt: string }
  | { type: 'driver'; driverId: string; status: string };
