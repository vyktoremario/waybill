import { SignJWT, jwtVerify } from 'jose';
import { verifyPassword } from '../crypto';
import type { Db } from '../db/db';
import { DomainError } from '../errors';

export type Role = 'dispatcher' | 'driver';
export interface Principal {
  sub: string;
  role: Role;
  name: string;
}

export class AuthService {
  private readonly key: Uint8Array;
  constructor(
    private readonly db: Db,
    secret: string,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async login(email: string, password: string): Promise<{ token: string; user: Principal }> {
    const u = (await this.db.query(`SELECT id, role, name, password_hash FROM users WHERE email = $1`, [String(email).toLowerCase()])).rows[0];
    if (!u || !verifyPassword(String(password), u.password_hash)) throw new DomainError('forbidden', 'wrong email or password');
    const user: Principal = { sub: u.id, role: u.role, name: u.name };
    const token = await new SignJWT({ role: user.role, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(this.key);
    return { token, user };
  }

  async verify(token: string | undefined): Promise<Principal | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (!payload.sub || (payload.role !== 'dispatcher' && payload.role !== 'driver')) return null;
      return { sub: payload.sub, role: payload.role, name: String(payload.name ?? '') };
    } catch {
      return null;
    }
  }
}
