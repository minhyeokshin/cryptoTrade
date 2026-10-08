import { userInfo } from 'node:os';
import { poolForRole } from './db/postgres.js';
import { verifyShadowDbPreflight } from './db/shadow-preflight.js';

if (userInfo().username !== 'bybit_shadow')
  throw new Error('Run DB preflight as bybit_shadow OS user');
const pool = poolForRole('bybit_shadow');
try {
  await verifyShadowDbPreflight(pool);
  process.stdout.write('SHADOW_DB_PREFLIGHT=PASS\n');
} finally {
  await pool.end();
}
