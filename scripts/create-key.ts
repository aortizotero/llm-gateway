// Usage: npm run create-key -- "Acme Corp"
// Creates a tenant with the default limits and prints its gateway key once.
// Replaced by the admin API in M3.
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run create-key -- "<tenant name>"');
  process.exit(1);
}

const { defaults } = loadConfig();
const db = openDb(process.env.DB_PATH ?? 'data/gateway.db');
const tenantId = db.createTenant(name, defaults);
console.log(`tenant: ${tenantId} (${name})`);
console.log(`key:    ${db.createKey(tenantId)}`);
console.log('Store this key now. It is not saved anywhere and cannot be shown again.');
