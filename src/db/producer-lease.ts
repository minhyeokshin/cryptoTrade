import type pg from 'pg';

// Distinct, fixed two-key advisory lock for the sole BTCUSD canonical writer.
const LOCK_CLASS = 73142;
const LOCK_OBJECT = 1001;

/** Holds the writer lock on the same PostgreSQL session used for all canonical writes. */
export class ProducerLease {
  private released = false;
  private epochId: string | null = null;
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
    if (this.released || this.epochId || !/^[0-9a-f-]{36}$/i.test(epochId) || !version) {
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
      this.epochId = epochId;
    } catch (error) { await this.client.query('ROLLBACK'); throw error; }
  }

  /** A restart resumes only the latest approved live boundary, never a failed attempt row. */
  async resumeApprovedEpoch(expectedApprovalId?: string): Promise<string> {
    if (this.released || this.epochId) throw new Error('Producer lease already released or bound');
    const result = await this.client.query<{ epoch_id: string; approval_id: string }>(
      `SELECT b.epoch_id::text,b.approval_id::text
         FROM bybit_live.node_live_epoch_boundaries b
         JOIN bybit_live.node_producer_epochs e ON e.epoch_id=b.epoch_id
        ORDER BY b.recorded_at DESC,b.approval_id DESC LIMIT 1`);
    const boundary = result.rows[0];
    if (result.rows.length !== 1 || !boundary ||
        (expectedApprovalId && boundary.approval_id !== expectedApprovalId)) {
      throw new Error('Latest approved Producer boundary unavailable or approval mismatch');
    }
    this.epochId = boundary.epoch_id;
    return boundary.epoch_id;
  }

  /** Heartbeat is emitted by the actual advisory-lock-owning DB session. */
  async heartbeat(state: 'RUNNING' | 'DEGRADED' | 'FAILED'): Promise<void> {
    if (this.released || !this.epochId) throw new Error('Producer lease/epoch unavailable');
    const result = await this.client.query(
      `INSERT INTO bybit_live.node_producer_heartbeats
         (epoch_id,backend_pid,backend_start,state)
       SELECT $1::uuid,a.pid,a.backend_start,$2
         FROM pg_catalog.pg_stat_activity a
        WHERE a.pid=pg_backend_pid()
          AND a.datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
          AND a.usename='bybit_producer' AND a.backend_start IS NOT NULL
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks l
            WHERE l.locktype='advisory' AND l.database=a.datid
              AND l.classid=73142::oid AND l.objid=1001::oid AND l.objsubid=2
              AND l.mode='ExclusiveLock' AND l.granted AND l.pid=a.pid)
       RETURNING id`, [this.epochId, state]);
    if (result.rowCount !== 1) throw new Error('Producer heartbeat session no longer owns writer lock');
  }

  async recordNewLiveBoundary(approvalId: string, epochId: string, gapStart: number,
    firstVerified: { id: string; timestamp: number }, completeMinuteStart: number): Promise<void> {
    if (this.released || this.epochId !== epochId || !Number.isSafeInteger(gapStart) ||
        !Number.isSafeInteger(firstVerified.timestamp) ||
        firstVerified.timestamp <= gapStart ||
        !Number.isSafeInteger(completeMinuteStart) || completeMinuteStart % 60_000 !== 0 ||
        completeMinuteStart <= firstVerified.timestamp) {
      throw new Error('Invalid new live epoch boundary');
    }
    await this.client.query(
      `INSERT INTO bybit_live.node_live_epoch_boundaries
        (approval_id,epoch_id,gap_start,gap_end,first_verified_trade_id,first_complete_minute_start,
         historical_source_gap)
       VALUES ($1::uuid,$2::uuid,to_timestamp($3::double precision/1000),
         to_timestamp($4::double precision/1000),$5,to_timestamp($6::double precision/1000),'OPEN')`,
      [approvalId, epochId, gapStart, firstVerified.timestamp, firstVerified.id, completeMinuteStart]);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try { await this.client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)',
      [LOCK_CLASS, LOCK_OBJECT]); }
    finally { this.client.release(); }
  }
}
