import nodemailer from 'nodemailer';
import { formatHourlyReport, type HourlySnapshot } from './hourly-report.js';

export interface HourlyClaim { claim(hourUtc: string): Promise<boolean>; }
export class HourlyMailer {
  constructor(private readonly claim: HourlyClaim) {}
  async send(snapshot: HourlySnapshot): Promise<'SENT' | 'DUPLICATE'> {
    if (!snapshot.startTimestamp) throw new Error('Shadow not activated; hourly mail forbidden');
    const hour = new Date(snapshot.reportTimestamp).toISOString().slice(0, 13) + ':00:00Z';
    if (!await this.claim.claim(hour)) return 'DUPLICATE';
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_EMAIL_TO } = process.env;
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !REPORT_EMAIL_TO) throw new Error('SMTP configuration missing');
    const transport = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await transport.sendMail({ from: SMTP_USER, to: REPORT_EMAIL_TO,
      subject: 'Forward Shadow Hourly Report', text: formatHourlyReport(snapshot) });
    return 'SENT';
  }
}
