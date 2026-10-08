import { afterEach, describe, expect, it, vi } from 'vitest';
import { HourlyMailer, validateHourlyEnvironment, type MailTransport } from '../src/report/mailer.js';
import type { HourlySnapshot } from '../src/report/hourly-report.js';

const snapshot: HourlySnapshot = {
  reportTimestamp: '2026-10-08T02:00:05Z', startTimestamp: '2026-10-08T01:30:00Z',
  currentEquity: 100, totalTrades: 0, wins: 0, losses: 0, winRate: null,
  profitFactor: null, expectancy: null, netPnl: 0, returnPct: 0,
  currentDrawdown: 0, mdd: 0, maxConsecutiveLosses: 0, openPosition: false,
  openPositionSide: null, openPositionEntry: null, openPositionUnrealizedPnl: null,
  latestSignal: null, latestConfidence: null, sourceLastTradeTimestamp: null,
  sourceFreshness: true, processUptimeSeconds: 1800,
};

afterEach(() => vi.unstubAllEnvs());
function smtpEnv(): void {
  vi.stubEnv('SMTP_HOST', 'localhost'); vi.stubEnv('SMTP_PORT', '587');
  vi.stubEnv('SMTP_USER', 'test@example.invalid'); vi.stubEnv('SMTP_PASS', 'test-only');
  vi.stubEnv('REPORT_EMAIL_TO', 'operator@example.invalid');
}

describe('hourly heartbeat delivery boundary', () => {
  it('checks SMTP and sends a zero-trade heartbeat once per UTC hour', async () => {
    smtpEnv();
    const claimed = new Set<string>();
    const messages: string[] = [];
    let verified = 0;
    let closed = 0;
    const factory = (): MailTransport => ({ verify: async () => { verified++; },
      sendMail: async (message) => { messages.push(message.text); }, close: () => { closed++; } });
    const mailer = new HourlyMailer({ claim: async (hour) => {
      if (claimed.has(hour)) return false;
      claimed.add(hour); return true;
    } }, factory);
    await mailer.verifyConnection();
    expect(await mailer.send(snapshot)).toBe('SENT');
    expect(await mailer.send({ ...snapshot, reportTimestamp: '2026-10-08T02:59:59Z' })).toBe('DUPLICATE');
    expect([...claimed]).toEqual(['2026-10-08T02:00:00Z']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('TOTAL_TRADES=0');
    expect(messages[0]).toContain('ACTUAL_ORDERS=0');
    expect([verified, closed]).toEqual([1, 2]);
  });
  it('refuses missing credentials and pre-activation delivery', async () => {
    expect(() => validateHourlyEnvironment({})).toThrow('SMTP');
    smtpEnv();
    const mailer = new HourlyMailer({ claim: async () => true },
      () => { throw new Error('must not create transport'); });
    await expect(mailer.send({ ...snapshot, startTimestamp: null })).rejects.toThrow('not activated');
  });
});
