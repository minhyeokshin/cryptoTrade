import type { HourlySnapshot } from './hourly-report.js';

export interface HourlySender { send(snapshot: HourlySnapshot): Promise<'SENT' | 'DUPLICATE'>; }
export interface SnapshotProvider { snapshot(at: Date): Promise<HourlySnapshot>; }

/** Triggers at the first check after each UTC hour. Durable claim belongs to the sender. */
export class HourlyScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly provider: SnapshotProvider, private readonly sender: HourlySender,
              private readonly onError: (error: unknown) => void) {}
  start(): void {
    if (this.timer) throw new Error('Hourly scheduler already started');
    this.timer = setInterval(() => { void this.tick(new Date()).catch(this.onError); }, 10_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick(now: Date): Promise<'SENT' | 'DUPLICATE' | 'NOT_STARTED' | 'BUSY'> {
    if (this.busy) return 'BUSY';
    this.busy = true;
    try {
      const hour = new Date(now);
      hour.setUTCMinutes(0, 0, 0);
      const snapshot = await this.provider.snapshot(now);
      if (!snapshot.startTimestamp || Date.parse(snapshot.startTimestamp) >= hour.getTime()) return 'NOT_STARTED';
      return this.sender.send({ ...snapshot, reportTimestamp: now.toISOString() });
    } finally { this.busy = false; }
  }
}
