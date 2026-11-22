import { readFileSync, writeFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

function required(name, pattern) {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`Invalid or missing build variable ${name}`);
  return value;
}

const resourceName = /^[a-z0-9][a-z0-9-]{0,62}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
config.name = required('YB_WORKER_NAME', resourceName);
for (const [index, prefix] of ['YB_DB', 'YB_BACKUP_DB'].entries()) {
  config.d1_databases[index].database_name = required(prefix + '_NAME', resourceName);
  config.d1_databases[index].database_id = required(prefix + '_ID', uuid);
}
if (config.d1_databases[0].database_id.toLowerCase() === config.d1_databases[1].database_id.toLowerCase()) {
  throw new Error('Business data and backups require separate D1 databases');
}
config.workers_dev = process.env.YB_ALLOW_WORKERS_DEV === 'true';
config.triggers = { crons: ['0 19 * * *'] };

writeFileSync(new URL('../wrangler.local.jsonc', import.meta.url), JSON.stringify(config, null, 2) + '\n');
