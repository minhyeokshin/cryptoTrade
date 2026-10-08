import type pg from 'pg';

// Distinct, fixed two-key advisory lock for the sole BTCUSD canonical writer.
const LOCK_CLASS = 73142;
const LOCK_OBJECT = 1001;

/** Holds the writer lock on the same PostgreSQL session used for all canonical writes. */
export class ProducerLease {
  private released = false;
  private constructor(readonly client: pg.PoolClient) {}

  static async acquire(pool: pg.Pool): Promise<ProducerLease> {
    const client = await pool.connect();
    try {
      const identity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user');
      if (identity.rows.length !== 1 || identity.rows[0]?.current_user !== 'bybit_producer' ||
          identity.rows[0]?.session_user !== 'bybit_producer') {
        throw new Error('Dedicated bybit_producer peer session required');
      }
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired',
        [LOCK_CLASS, LOCK_OBJECT]);
      if (result.rows[0]?.acquired !== true) throw new Error('Another Node canonical writer holds the lock');
      return new ProducerLease(client);
    } catch (error) { client.release(); throw error; }
  }

  async startEpoch(epochId: string, version: string): Promise<void> {
    if (this.released || !/^[0-9a-f-]{36}$/i.test(epochId) || !version) {
      throw new Error('Invalid Node producer epoch');
    }
    try {
      await this.client.query('BEGIN');
      await this.client.query(
        `INSERT INTO bybit_live.node_producer_epochs
           (epoch_id,runtime_name,runtime_version,writer_role,historical_source_gap)
         VALUES ($1::uuid,'cryptoTrade-node',$2,'bybit_producer','OPEN')`,
        [epochId, version]);
      await this.client.query(
        `INSERT INTO bybit_live.operational_health_events (state,reason)
         VALUES ('STARTING',$1)`, [`cryptoTrade-node epoch ${epochId}`]);
      await this.client.query('COMMIT');
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try { await this.client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)',
      [LOCK_CLASS, LOCK_OBJECT]); }
    finally { this.client.release(); }
  }
}
