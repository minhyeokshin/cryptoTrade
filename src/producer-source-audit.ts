import { userInfo } from 'node:os';
import { poolForReadOnlyRole } from './db/postgres.js';
import { verifyProducerDbPreflight } from './db/producer-preflight.js';
import { auditProducerSource } from './market/source-audit.js';

if (userInfo().username !== 'bybit_producer')
  throw new Error('Run source audit as bybit_producer OS user');
const pool = poolForReadOnlyRole('bybit_producer');
try {
  await verifyProducerDbPreflight(pool);
  const result = await auditProducerSource(pool);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.sourceFresh) process.exitCode = 1;
} finally { await pool.end(); }
