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
`;

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
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

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const now = () => new Date().toISOString();
  const findKey = db.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL');
  const insertTenant = db.prepare(
    'INSERT INTO tenants (id, name, monthly_budget_usd_micros, rpm, tpm, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertKey = db.prepare(
    'INSERT INTO api_keys (id, tenant_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertRequest = db.prepare(
    `INSERT INTO requests (id, tenant_id, alias, provider, model, input_tokens, output_tokens, cost_usd_micros,
       latency_ms, attempts, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    raw: db,

    tenantForKey(key: string): string | null {
      const row = findKey.get(hashKey(key)) as { tenant_id: string } | undefined;
      return row?.tenant_id ?? null;
    },

    createTenant(name: string, limits: { monthlyBudgetUsd: number; rpm: number; tpm: number }): string {
      const id = randomUUID();
      insertTenant.run(id, name, Math.round(limits.monthlyBudgetUsd * 1_000_000), limits.rpm, limits.tpm, now());
      return id;
    },

    // The plaintext key is returned once and never stored.
    createKey(tenantId: string): string {
      const key = `gw_${randomBytes(32).toString('base64url')}`;
      insertKey.run(randomUUID(), tenantId, hashKey(key), key.slice(0, 10), now());
      return key;
    },

    recordRequest(r: RequestRow): void {
      insertRequest.run(
        randomUUID(), r.tenantId, r.alias, r.provider, r.model, r.inputTokens, r.outputTokens, r.costUsdMicros,
        r.latencyMs, r.attempts, r.status, r.error, now(),
      );
    },
  };
}

export type Db = ReturnType<typeof openDb>;
