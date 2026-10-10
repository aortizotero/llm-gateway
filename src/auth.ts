import type { Context } from 'hono';
import type { Db } from './db.ts';
import { GatewayError } from './errors.ts';

export function authenticate(c: Context, db: Db): string {
  const header = c.req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const tenantId = key ? db.tenantForKey(key) : null;
  if (!tenantId) throw new GatewayError(401, 'invalid_api_key', 'Missing or invalid gateway API key');
  return tenantId;
}
