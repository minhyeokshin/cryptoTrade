import pg from 'pg';

export type DatabaseRole = 'bybit_producer' | 'bybit_shadow';
export function poolForRole(role: DatabaseRole): pg.Pool {
  if (process.env.PGUSER !== role) throw new Error(`Dedicated PostgreSQL peer role ${role} required`);
  if (process.env.DATABASE_URL || process.env.PGPASSWORD) throw new Error('Password/TCP DSN forbidden for live runtime');
  return new pg.Pool({ host: '/var/run/postgresql', database: process.env.PGDATABASE ?? 'btc_analysis',
    user: role, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
}

/** Diagnostic-only peer connection; PostgreSQL rejects mutations even if the role can INSERT. */
export function poolForReadOnlyRole(role: DatabaseRole): pg.Pool {
  if (process.env.PGUSER !== role) throw new Error(`Dedicated PostgreSQL peer role ${role} required`);
  if (process.env.DATABASE_URL || process.env.PGPASSWORD)
    throw new Error('Password/TCP DSN forbidden for live runtime');
  return new pg.Pool({ host: '/var/run/postgresql', database: process.env.PGDATABASE ?? 'btc_analysis',
    user: role, options: '-c default_transaction_read_only=on', max: 2,
    idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 });
}

export async function verifyPeerRole(pool: pg.Pool, expected: DatabaseRole): Promise<void> {
  const result = await pool.query<{ current_user: string }>('SELECT current_user');
  if (result.rows[0]?.current_user !== expected) throw new Error('PostgreSQL peer role mismatch');
}
