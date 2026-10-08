import { userInfo } from 'node:os';
import { poolForRole } from './db/postgres.js';
import { verifyProducerDbPreflight } from './db/producer-preflight.js';

if (userInfo().username !== 'bybit_producer')
  throw new Error('Run DB preflight as bybit_producer OS user');
const pool = poolForRole('bybit_producer');
try {
  await verifyProducerDbPreflight(pool);
  process.stdout.write('PRODUCER_DB_PREFLIGHT=PASS\n');
} finally {
  await pool.end();
}
