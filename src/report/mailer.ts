import nodemailer from 'nodemailer';
import { formatHourlyReport, type HourlySnapshot } from './hourly-report.js';

export interface HourlyClaim { claim(hourUtc: string): Promise<boolean>; }
type MailMessage = { from: string; to: string; subject: string; text: string };
export interface MailTransport {
  verify(): Promise<unknown>;
  sendMail(message: MailMessage): Promise<unknown>;
  close(): void;
}
type SmtpConfig = { host: string; port: number; user: string; pass: string; to: string };
export function validateHourlyEnvironment(env: NodeJS.ProcessEnv): SmtpConfig {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REPORT_EMAIL_TO } = env;
  const port = Number(SMTP_PORT);
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REPORT_EMAIL_TO ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Hourly SMTP configuration missing or invalid');
  }
  return { host: SMTP_HOST, port, user: SMTP_USER, pass: SMTP_PASS, to: REPORT_EMAIL_TO };
}
export class HourlyMailer {
  constructor(private readonly claim: HourlyClaim,
              private readonly transportFactory: (config: SmtpConfig) => MailTransport =
                (config) => nodemailer.createTransport({ host: config.host, port: config.port,
                  secure: config.port === 465, auth: { user: config.user, pass: config.pass } })) {}
  async verifyConnection(): Promise<void> {
    const transport = this.transportFactory(validateHourlyEnvironment(process.env));
    try { await transport.verify(); }
    finally { transport.close(); }
  }
  async send(snapshot: HourlySnapshot): Promise<'SENT' | 'DUPLICATE'> {
    if (!snapshot.startTimestamp) throw new Error('Shadow not activated; hourly mail forbidden');
    const hour = new Date(snapshot.reportTimestamp).toISOString().slice(0, 13) + ':00:00Z';
    const config = validateHourlyEnvironment(process.env);
    if (!await this.claim.claim(hour)) return 'DUPLICATE';
    const transport = this.transportFactory(config);
    try {
      await transport.sendMail({ from: config.user, to: config.to,
        subject: 'Forward Shadow Hourly Report', text: formatHourlyReport(snapshot) });
    } finally { transport.close(); }
    return 'SENT';
  }
}
