import type pg from 'pg';

/** Process-lifetime advisory lock prevents two Node Shadow engines on different activations. */
export class ShadowRunLease {
  private released = false;
  private constructor(private readonly client: pg.PoolClient) {}
  static async acquire(pool: pg.Pool): Promise<ShadowRunLease> {
    const client = await pool.connect();
    try {
      const identity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user');
      if (identity.rows.length !== 1 || identity.rows[0]?.current_user !== 'bybit_shadow' ||
          identity.rows[0]?.session_user !== 'bybit_shadow') {
        throw new Error('Dedicated bybit_shadow peer session required');
      }
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', [73142, 2001]);
      if (result.rows[0]?.acquired !== true) throw new Error('Another Node Shadow engine holds the lock');
      return new ShadowRunLease(client);
    } catch (error) { client.release(); throw error; }
  }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try { await this.client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)',
      [73142, 2001]); }
    finally { this.client.release(); }
  }
}
