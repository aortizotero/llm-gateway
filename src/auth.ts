import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import type { Db, Tenant } from './db.ts';
import { GatewayError } from './errors.ts';

function bearer(c: Context): string {
  const header = c.req.header('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export function authenticate(c: Context, db: Db): Tenant {
  const key = bearer(c);
  const tenant = key ? db.tenantForKey(key) : null;
  if (!tenant) throw new GatewayError(401, 'invalid_api_key', 'Missing or invalid gateway API key');
  return tenant;
}

// Hashing both sides first gives equal-length buffers, which timingSafeEqual requires.
export function authenticateAdmin(c: Context, adminKey: string | undefined): void {
  if (!adminKey) throw new GatewayError(404, 'not_found', 'Admin API is disabled (GATEWAY_ADMIN_KEY not set)');
  const digest = (s: string) => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(digest(bearer(c)), digest(adminKey))) {
    throw new GatewayError(401, 'invalid_api_key', 'Missing or invalid admin key');
  }
}
