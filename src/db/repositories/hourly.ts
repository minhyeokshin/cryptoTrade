import type pg from 'pg';
import type { HourlyClaim } from '../../report/mailer.js';

/** At-most-once UTC-hour claim. An SMTP failure after claim requires operator review. */
export class PostgresHourlyClaim implements HourlyClaim {
  constructor(private readonly pool: pg.Pool) {}
  async claim(hourUtc: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO shadow_trading_v1.node_hourly_reports (report_hour)
       VALUES ($1::timestamptz) ON CONFLICT (report_hour) DO NOTHING RETURNING report_hour`,
      [hourUtc]);
    return Boolean(result.rowCount);
  }
}
