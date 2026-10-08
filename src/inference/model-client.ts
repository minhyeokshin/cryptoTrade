import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FROZEN } from '../config/frozen.js';
import type { CanonicalCandle, FrozenPrediction } from '../types/domain.js';
import { assertCausalCandles } from './feature-builder.js';

export class FrozenModelClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: FrozenPrediction) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private lines = '';
  constructor(private readonly python: string, private readonly worker: string, private readonly modelFile: string) {}
  async start(): Promise<void> {
    const bytes = await readFile(this.modelFile);
    if (createHash('sha256').update(bytes).digest('hex') !== FROZEN.directionModelHash) throw new Error('Frozen Direction model hash mismatch');
    this.child = spawn(this.python, [this.worker], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, PYTHON_RESEARCH_ROOT: process.env.PYTHON_RESEARCH_ROOT,
        PYTHONDONTWRITEBYTECODE: '1' } });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.lines += chunk.toString();
      for (;;) {
        const end = this.lines.indexOf('\n'); if (end < 0) break;
        const line = this.lines.slice(0, end); this.lines = this.lines.slice(end + 1);
        const value = JSON.parse(line) as { id: number; prediction?: FrozenPrediction; error?: string };
        const request = this.pending.get(value.id); if (!request) continue;
        clearTimeout(request.timer); this.pending.delete(value.id);
        if (value.error) request.reject(new Error(value.error));
        else if (value.prediction) request.resolve(value.prediction);
      }
    });
    this.child.on('exit', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Python inference exited')); }
      this.pending.clear(); this.child = null;
    });
  }
  predict(candles: CanonicalCandle[], decisionTimestamp: number): Promise<FrozenPrediction> {
    assertCausalCandles(candles, decisionTimestamp);
    if (!this.child) throw new Error('Inference worker not ready');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Python inference timeout')); this.child?.kill(); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, candles, decisionTimestamp }) + '\n');
    });
  }
  stop(): void { this.child?.kill(); }
}
