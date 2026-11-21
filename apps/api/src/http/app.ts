import 'reflect-metadata';
import {
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Req,
  Res,
  type ArgumentsHost,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AuthService, type Principal, type Role } from '../auth/auth';
import type { Core } from '../core';
import { withTx } from '../db/db';
import { DomainError, invalid, notFound } from '../errors';
import { post } from '../ledger/ledger';
import { enqueue } from '../outbox/outbox';
import { hookstormReset, hookstormState } from './hookstorm';

const CORE = Symbol('CORE');
const AUTH = Symbol('AUTH');
const ROLE = 'role';
const Roles = (role: Role) => SetMetadata(ROLE, role);

type AuthedRequest = Request & { principal: Principal; rawBody?: Buffer };

@Injectable()
class RoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: AuthService,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const role = this.reflector.getAllAndOverride<Role | undefined>(ROLE, [ctx.getHandler(), ctx.getClass()]);
    if (!role) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const principal = await this.auth.verify(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!principal) throw new HttpException({ error: 'unauthorized', message: 'sign in required' }, 401);
    if (principal.role !== role) throw new HttpException({ error: 'forbidden', message: `${role} only` }, 403);
    req.principal = principal;
    return true;
  }
}

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      const status = { conflict: 409, forbidden: 403, not_found: 404, invalid: 422, locked: 423 }[err.code];
      res.status(status).json({ error: err.code, message: err.message, ...err.details });
    } else if (err instanceof ZodError) {
      res.status(400).json({ error: 'bad_request', message: 'invalid input', issues: err.issues });
    } else if (err instanceof HttpException) {
      const body = err.getResponse();
      res.status(err.getStatus()).json(typeof body === 'string' ? { error: body } : body);
    } else {
      console.error('[http] unhandled', err);
      res.status(500).json({ error: 'internal', message: 'something went wrong' });
    }
  }
}

@Controller()
class PublicController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('health')
  async health() {
    await this.core.db.query('SELECT 1');
    return { ok: true };
  }

  @Post('orders')
  async create(@Body() body: unknown) {
    const { order, trackingToken } = await this.core.orders.create(body);
    return { order, trackingToken, trackingUrl: `${this.core.config.webUrl}/t/${trackingToken}` };
  }

  @Get('track/:token')
  track(@Param('token') token: string) {
    return this.core.orders.getForTracking(token);
  }

  @Post('track/:token/pay')
  async pay(@Param('token') token: string, @Headers('idempotency-key') key: string) {
    const o = await this.core.orders.getForTracking(token);
    return this.core.payments.initiate(o.id, key);
  }

  @Post('track/:token/cancel')
  async cancel(@Param('token') token: string, @Body() body: { reason?: string; commandId?: string }) {
    const o = await this.core.orders.getForTracking(token);
    await this.core.orders.cancel(o.id, 'customer', undefined, body?.reason?.slice(0, 200) || 'cancelled by customer', body?.commandId);
    return this.core.orders.getForTracking(token);
  }

  @Get('track/:token/photo')
  async trackPhoto(@Param('token') token: string, @Res() res: Response) {
    const o = await this.core.orders.getForTracking(token);
    const row = (
      await this.core.db.query(`SELECT p.mime, p.bytes FROM orders o JOIN photos p ON p.id = o.pickup_photo_id WHERE o.id = $1`, [o.id])
    ).rows[0];
    if (!row) throw notFound('no photo');
    res.type(row.mime).send(row.bytes);
  }

  /** Paystack webhook (ADR-0004). 200 only after the effect is committed; anything else makes Paystack retry. */
  @Post('webhooks/paystack')
  @HttpCode(200)
  async paystack(@Req() req: AuthedRequest, @Headers('x-paystack-signature') sig: string) {
    if (!req.rawBody) throw invalid('raw body missing');
    const result = await this.core.payments.handleWebhook(req.rawBody, sig);
    return { ok: true, result };
  }
}

@Controller('auth')
class AuthController {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body?.email, body?.password);
  }
}

@Controller('dispatch')
@UseGuards(RoleGuard)
@Roles('dispatcher')
class DispatchController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('orders')
  list() {
    return this.core.orders.listForDispatch();
  }

  @Get('orders/:id')
  detail(@Param('id') id: string) {
    return this.core.orders.detailForDispatch(id);
  }

  @Post('orders/:id/assign')
  @HttpCode(200)
  async assign(@Param('id') id: string, @Body() body: { driverId: string; commandId?: string }, @Req() req: AuthedRequest) {
    await this.core.assignment.dispatcherAssign(id, body?.driverId, req.principal.sub, body?.commandId);
    return this.core.orders.detailForDispatch(id);
  }

  @Post('orders/:id/unassign')
  @HttpCode(200)
  async unassign(@Param('id') id: string, @Body() body: { commandId?: string }, @Req() req: AuthedRequest) {
    await this.core.assignment.unassign(id, req.principal.sub, body?.commandId);
    return this.core.orders.detailForDispatch(id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: { reason?: string; commandId?: string }, @Req() req: AuthedRequest) {
    await this.core.orders.cancel(id, 'dispatcher', req.principal.sub, body?.reason?.slice(0, 200) || 'cancelled by dispatch', body?.commandId);
    return this.core.orders.detailForDispatch(id);
  }

  /** After a failed delivery comes back (RETURNED), dispatch decides whether to refund. Same refund path. */
  @Post('orders/:id/refund')
  @HttpCode(200)
  async refund(@Param('id') id: string, @Req() req: AuthedRequest) {
    await withTx(this.core.db, async (tx) => {
      const o = (await tx.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!o) throw notFound('order not found');
      if (o.status !== 'RETURNED') throw new DomainError('conflict', 'only returned orders are refunded from here; cancel paid orders instead');
      const p = (await tx.query(`SELECT id, amount_kobo::int AS amount, status FROM payments WHERE order_id = $1 AND role = 'primary' FOR UPDATE`, [id])).rows[0];
      if (!p || p.status !== 'succeeded') throw new DomainError('conflict', 'nothing to refund');
      const already = await tx.query(`SELECT 1 FROM refunds WHERE payment_id = $1`, [p.id]);
      if (already.rowCount) return;
      await post(tx, [{ account: 'order_liability', amountKobo: p.amount }, { account: 'refunds_payable', amountKobo: -p.amount }], {
        memo: `refund after return, by ${req.principal.name}`,
        orderId: id,
        paymentId: p.id,
      });
      await enqueue(tx, { type: 'payment.refund_required', payload: { paymentId: p.id, reason: 'returned to sender' } }, { aggregateId: id });
    });
    return this.core.orders.detailForDispatch(id);
  }

  @Get('drivers')
  async drivers() {
    return (
      await this.core.db.query(
        `SELECT d.user_id AS id, u.name, d.status, d.vehicle, d.last_seen_at,
                ST_Y(d.last_location::geometry) AS lat, ST_X(d.last_location::geometry) AS lng,
                (SELECT o.id FROM orders o WHERE o.driver_id = d.user_id AND o.status IN ('ASSIGNED','EN_ROUTE_TO_PICKUP','PICKED_UP','EN_ROUTE_TO_DROPOFF','RETURNING') LIMIT 1) AS order_id
           FROM drivers d JOIN users u ON u.id = d.user_id ORDER BY u.name`,
      )
    ).rows;
  }

  /** The health strip: outbox backlog and dead letters, so failures are visible (SPEC §8). */
  @Get('health')
  async health() {
    const ob = (
      await this.core.db.query(
        `SELECT count(*)::int AS waiting, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::int AS oldest_seconds FROM outbox WHERE published_at IS NULL`,
      )
    ).rows[0];
    const dlq = await readDeadLetters(this.core);
    return { outbox: ob, deadLetters: dlq };
  }

  @Get('photos/:id')
  async photo(@Param('id') id: string, @Res() res: Response) {
    const row = (await this.core.db.query(`SELECT mime, bytes FROM photos WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFound('no photo');
    res.type(row.mime).send(row.bytes);
  }
}

/** The worker writes dead-letter queue depths to Redis every few seconds (the api has no broker connection). */
async function readDeadLetters(core: Core): Promise<number | null> {
  const raw = await core.realtime.getKey('health:dlq');
  return raw == null ? null : Number(raw);
}

@Controller('driver')
@UseGuards(RoleGuard)
@Roles('driver')
class DriverController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Get('current')
  current(@Req() req: AuthedRequest) {
    return this.core.drivers.current(req.principal.sub);
  }

  @Post('availability')
  @HttpCode(200)
  availability(@Req() req: AuthedRequest, @Body() body: { status: 'available' | 'offline' }) {
    if (body?.status !== 'available' && body?.status !== 'offline') throw invalid('status must be available or offline');
    return this.core.drivers.setAvailability(req.principal.sub, body.status);
  }

  @Post('commands')
  @HttpCode(200)
  command(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.core.drivers.handle(req.principal.sub, body);
  }

  @Post('locations')
  @HttpCode(200)
  locations(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.core.drivers.ingestLocations(req.principal.sub, body);
  }

  @Put('photos/:id')
  @HttpCode(200)
  async photo(@Req() req: AuthedRequest, @Param('id') id: string, @Headers('content-type') mime: string) {
    const bytes = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : null);
    if (!bytes?.length) throw invalid('empty photo');
    await this.core.drivers.savePhoto(req.principal.sub, id, (mime ?? '').split(';')[0]!.trim(), bytes);
    return { id };
  }
}

@Controller('hookstorm')
class HookstormController {
  constructor(@Inject(CORE) private readonly core: Core) {}
  @Post('reset')
  @HttpCode(200)
  reset(@Body() body: unknown) {
    return hookstormReset(this.core, body);
  }
  @Get('state')
  state() {
    return hookstormState(this.core);
  }
}

@Module({})
export class AppModule {
  static forCore(core: Core): DynamicModule {
    const controllers: any[] = [PublicController, AuthController, DispatchController, DriverController];
    if (core.config.hookstormRoutes) controllers.push(HookstormController);
    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: CORE, useValue: core },
        { provide: AUTH, useValue: new AuthService(core.db, core.config.jwtSecret) },
        RoleGuard,
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

export { ErrorFilter };
