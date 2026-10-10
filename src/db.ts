import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_budget_usd_micros INTEGER NOT NULL,
  rpm INTEGER NOT NULL,
  tpm INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_spend (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period TEXT NOT NULL,
  usd_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  alias TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  status INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_tenant_created ON requests (tenant_id, created_at);
`;

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Budget periods are calendar months in UTC.
export function periodOf(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export interface Tenant {
  id: string;
  name: string;
  monthlyBudgetUsdMicros: number;
  rpm: number;
  tpm: number;
}

export interface Limits {
  monthlyBudgetUsd: number;
  rpm: number;
  tpm: number;
}

export interface RequestRow {
  tenantId: string;
  alias: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  latencyMs: number;
  attempts: number;
  status: number;
  error: string | null;
}

const TENANT_COLUMNS = 'id, name, monthly_budget_usd_micros AS monthlyBudgetUsdMicros, rpm, tpm';
const toMicros = (usd: number) => Math.round(usd * 1_000_000);

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const now = () => new Date().toISOString();
  const q = {
    tenantByKey: db.prepare(
      `SELECT t.id, t.name, t.monthly_budget_usd_micros AS monthlyBudgetUsdMicros, t.rpm, t.tpm
       FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    ),
    tenant: db.prepare(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = ?`),
    insertTenant: db.prepare(
      'INSERT INTO tenants (id, name, monthly_budget_usd_micros, rpm, tpm, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    updateTenant: db.prepare(
      `UPDATE tenants SET monthly_budget_usd_micros = COALESCE(?, monthly_budget_usd_micros),
       rpm = COALESCE(?, rpm), tpm = COALESCE(?, tpm) WHERE id = ?`,
    ),
    insertKey: db.prepare('INSERT INTO api_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)'),
    revokeKey: db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    spend: db.prepare('SELECT usd_micros FROM tenant_spend WHERE tenant_id = ? AND period = ?'),
    addSpend: db.prepare(
      `INSERT INTO tenant_spend (tenant_id, period, usd_micros) VALUES (?, ?, ?)
       ON CONFLICT (tenant_id, period) DO UPDATE SET usd_micros = usd_micros + excluded.usd_micros`,
    ),
    insertRequest: db.prepare(
      `INSERT INTO requests (id, tenant_id, alias, provider, model, input_tokens, output_tokens, cost_usd_micros,
         latency_ms, attempts, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    usage: db.prepare(
      `SELECT provider, model, COUNT(*) AS requests, SUM(status = 200) AS succeeded,
         SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cost_usd_micros) AS costUsdMicros
       FROM requests WHERE tenant_id = ? AND substr(created_at, 1, 7) = ? GROUP BY provider, model ORDER BY costUsdMicros DESC`,
    ),
  };

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    raw: db,

    tenantForKey(key: string): Tenant | null {
      return (q.tenantByKey.get(hashKey(key)) as unknown as Tenant | undefined) ?? null;
    },

    getTenant(id: string): Tenant | null {
      return (q.tenant.get(id) as unknown as Tenant | undefined) ?? null;
    },

    createTenant(name: string, limits: Limits): string {
      const id = randomUUID();
      q.insertTenant.run(id, name, toMicros(limits.monthlyBudgetUsd), limits.rpm, limits.tpm, now());
      return id;
    },

    updateTenant(id: string, limits: Partial<Limits>): boolean {
      const budget = limits.monthlyBudgetUsd === undefined ? null : toMicros(limits.monthlyBudgetUsd);
      return q.updateTenant.run(budget, limits.rpm ?? null, limits.tpm ?? null, id).changes > 0;
    },

    // The plaintext key is returned once and never stored.
    createKey(tenantId: string): { id: string; key: string; prefix: string } {
      const key = `gw_${randomBytes(32).toString('base64url')}`;
      const id = randomUUID();
      const prefix = key.slice(0, 10);
      q.insertKey.run(id, tenantId, hashKey(key), prefix, now());
      return { id, key, prefix };
    },

    revokeKey(id: string): boolean {
      return q.revokeKey.run(now(), id).changes > 0;
    },

    spend(tenantId: string, period = periodOf()): number {
      return (q.spend.get(tenantId, period) as { usd_micros: number } | undefined)?.usd_micros ?? 0;
    },

    // Reserve-then-settle: the worst-case cost is booked before the provider call, so concurrent
    // requests can never push a tenant past its budget.
    reserve(tenant: Tenant, micros: number, period = periodOf()): boolean {
      return tx(() => {
        const spent = (q.spend.get(tenant.id, period) as { usd_micros: number } | undefined)?.usd_micros ?? 0;
        if (spent + micros > tenant.monthlyBudgetUsdMicros) return false;
        q.addSpend.run(tenant.id, period, micros);
        return true;
      });
    },

    // Records the request and swaps the reservation for the actual cost, atomically.
    settle(r: RequestRow, reservedMicros: number, period = periodOf()): void {
      tx(() => {
        q.insertRequest.run(
          randomUUID(), r.tenantId, r.alias, r.provider, r.model, r.inputTokens, r.outputTokens, r.costUsdMicros,
          r.latencyMs, r.attempts, r.status, r.error, now(),
        );
        if (r.costUsdMicros !== reservedMicros) q.addSpend.run(r.tenantId, period, r.costUsdMicros - reservedMicros);
      });
    },

    usage(tenantId: string, period = periodOf()) {
      return q.usage.all(tenantId, period) as Array<{
        provider: string | null;
        model: string | null;
        requests: number;
        succeeded: number;
        inputTokens: number;
        outputTokens: number;
        costUsdMicros: number;
      }>;
    },
  };
}

export type Db = ReturnType<typeof openDb>;
