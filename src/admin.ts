import { Hono } from 'hono';
import { authenticateAdmin } from './auth.ts';
import type { Breakers } from './breaker.ts';
import type { Config } from './config.ts';
import { periodOf, type Db, type Limits } from './db.ts';
import { GatewayError } from './errors.ts';

const usd = (micros: number) => Math.round(micros) / 1_000_000;

function parseLimits(body: Record<string, unknown>): Partial<Limits> {
  const limits: Partial<Limits> = {};
  for (const field of ['monthlyBudgetUsd', 'rpm', 'tpm'] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new GatewayError(400, 'invalid_request_error', `"${field}" must be a non-negative number`);
    }
    limits[field] = v;
  }
  return limits;
}

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function adminRoutes({ db, config, breakers, adminKey }: { db: Db; config: Config; breakers: Breakers; adminKey?: string }) {
  const admin = new Hono();

  admin.use(async (c, next) => {
    authenticateAdmin(c, adminKey);
    await next();
  });

  const tenantOr404 = (id: string) => {
    const tenant = db.getTenant(id);
    if (!tenant) throw new GatewayError(404, 'not_found', `Tenant ${id} not found`);
    return tenant;
  };

  const view = (id: string) => {
    const t = tenantOr404(id);
    return { id: t.id, name: t.name, monthlyBudgetUsd: usd(t.monthlyBudgetUsdMicros), rpm: t.rpm, tpm: t.tpm };
  };

  admin.post('/tenants', async (c) => {
    const body = await jsonBody(c);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new GatewayError(400, 'invalid_request_error', '"name" is required');
    }
    const { rpm, tpm, monthlyBudgetUsd } = config.defaults;
    const id = db.createTenant(body.name.trim(), { rpm, tpm, monthlyBudgetUsd, ...parseLimits(body) });
    return c.json(view(id), 201);
  });

  admin.patch('/tenants/:id', async (c) => {
    const id = c.req.param('id');
    tenantOr404(id);
    db.updateTenant(id, parseLimits(await jsonBody(c)));
    return c.json(view(id));
  });

  admin.post('/tenants/:id/keys', (c) => {
    const id = c.req.param('id');
    tenantOr404(id);
    return c.json({ ...db.createKey(id), note: 'Store this key now. It cannot be shown again.' }, 201);
  });

  admin.delete('/keys/:id', (c) => {
    if (!db.revokeKey(c.req.param('id'))) throw new GatewayError(404, 'not_found', 'Key not found or already revoked');
    return c.body(null, 204);
  });

  admin.get('/usage', (c) => {
    const id = c.req.query('tenant');
    if (!id) throw new GatewayError(400, 'invalid_request_error', '"tenant" query parameter is required');
    const period = c.req.query('period') ?? periodOf();
    if (!/^\d{4}-\d{2}$/.test(period)) throw new GatewayError(400, 'invalid_request_error', '"period" must be YYYY-MM');
    const tenant = view(id);
    const byModel = db.usage(id, period).map((r) => ({ ...r, costUsd: usd(r.costUsdMicros), costUsdMicros: undefined }));
    return c.json({
      tenant,
      period,
      spentUsd: usd(db.spend(id, period)),
      remainingUsd: usd(tenant.monthlyBudgetUsd * 1_000_000 - db.spend(id, period)),
      byModel,
    });
  });

  admin.get('/breakers', (c) => c.json(breakers.states()));

  return admin;
}
