import { FROZEN } from '../config/frozen.js';
import type { FrozenPrediction, Side } from '../types/domain.js';
import { DrawdownTracker } from './drawdown.js';
import { executionPrice, inverseContracts, settle } from './inverse-pnl.js';

export interface Position {
  signalId: string; signalTimestamp: number; side: Side; confidence: number;
  entryAt: number; rawEntry: number; executionEntry: number; contracts: number;
  equityBefore: number; marginUsd: number; notionalUsd: number; mfeBtc: number; maeBtc: number;
}
export interface ClosedPosition extends Position {
  exitAt: number; rawExit: number; executionExit: number; exitReason: 'DIRECTION_FLIP' | 'HORIZON';
  grossBtc: number; netBtc: number; netUsd: number; feesBtc: number; slippageBtc: number;
  equityAfter: number; peakEquity: number; drawdownPct: number;
}
export interface ShadowState { activationAt: number; balanceBtc: number; open: Position | null; closed: ClosedPosition[]; processedSignals: string[]; peakEquity: number; mdd: number; }

export function signalId(p: FrozenPrediction): string { return `${FROZEN.strategyVersion}:BTCUSD:${p.decisionTimestamp}`; }

export class ShadowEngine {
  readonly state: ShadowState;
  private readonly seen: Set<string>;
  private readonly drawdown: DrawdownTracker;
  constructor(activationAt: number, initialMark: number, private readonly lotSize: number, restored?: ShadowState) {
    if (!Number.isFinite(initialMark) || initialMark <= 0) throw new Error('Official initial mark required');
    this.state = restored ?? { activationAt, balanceBtc: FROZEN.initialEquityUsd / initialMark,
      open: null, closed: [], processedSignals: [], peakEquity: 100, mdd: 0 };
    if (this.state.activationAt !== activationAt) throw new Error('Activation mismatch');
    this.seen = new Set(this.state.processedSignals);
    this.drawdown = new DrawdownTracker(this.state.peakEquity);
    this.drawdown.mdd = this.state.mdd;
  }
  equityUsd(mark: number): number {
    if (!Number.isFinite(mark) || mark <= 0) throw new Error('Invalid mark');
    const p = this.state.open;
    const unrealized = p ? (p.side === 'LONG' ? 1 : -1) * p.contracts * (1 / p.executionEntry - 1 / mark) : 0;
    return (this.state.balanceBtc + unrealized) * mark;
  }
  observePrice(price: number): void {
    const p = this.state.open;
    if (!p) return;
    const excursion = (p.side === 'LONG' ? 1 : -1) * p.contracts * (1 / p.executionEntry - 1 / price);
    p.mfeBtc = Math.max(p.mfeBtc, excursion);
    p.maeBtc = Math.min(p.maeBtc, excursion);
  }
  consume(prediction: FrozenPrediction, executionAt: number, rawPrice: number, mark: number, sourceFresh: boolean): { entry: Position | null; exit: ClosedPosition | null; status: string } {
    if (!sourceFresh) return { entry: null, exit: null, status: 'SOURCE_BLOCKED' };
    if (prediction.modelHash !== FROZEN.directionModelHash || prediction.featureSchemaHash !== FROZEN.featureSchemaHash) throw new Error('Frozen hash mismatch');
    if (prediction.featureCutoff > prediction.decisionTimestamp || prediction.decisionTimestamp >= executionAt) throw new Error('Future leakage/noncausal execution');
    if (prediction.decisionTimestamp < this.state.activationAt || executionAt <= this.state.activationAt) return { entry: null, exit: null, status: 'PRE_ACTIVATION' };
    if (executionAt - prediction.decisionTimestamp > 60_000) throw new Error('Execution observation too late');
    const id = signalId(prediction);
    if (this.seen.has(id)) return { entry: null, exit: null, status: 'DUPLICATE' };
    this.seen.add(id); this.state.processedSignals.push(id);
    const actionable = prediction.side !== 'NO_ACTION' && prediction.confidence >= FROZEN.threshold;
    const held = this.state.open;
    let exit: ClosedPosition | null = null;
    if (held) {
      const horizon = executionAt >= held.signalTimestamp + FROZEN.horizonMs;
      const flip = !horizon && actionable && prediction.flipActionable && prediction.side !== held.side;
      if (horizon || flip) exit = this.close(executionAt, rawPrice, mark, horizon ? 'HORIZON' : 'DIRECTION_FLIP');
    }
    let entry: Position | null = null;
    if (!held && actionable && prediction.actionable && prediction.decisionTimestamp % (5 * 60_000) === 0) {
      entry = this.open(id, prediction, executionAt, rawPrice, mark);
    }
    return { entry, exit, status: entry ? 'ENTRY' : exit ? 'EXIT' : 'NO_ACTION' };
  }
  private open(id: string, p: FrozenPrediction, at: number, raw: number, mark: number): Position | null {
    if (p.side === 'NO_ACTION') return null;
    const equity = this.equityUsd(mark);
    const sizing = inverseContracts(equity, this.lotSize);
    if (sizing.contracts <= 0) return null;
    const execution = executionPrice(raw, p.side, true);
    const fee = FROZEN.feeRate * sizing.contracts / execution;
    if (fee * execution > equity - sizing.margin) throw new Error('Insufficient fee reserve');
    this.state.balanceBtc -= fee;
    const position: Position = { signalId: id, signalTimestamp: p.decisionTimestamp,
      side: p.side, confidence: p.confidence, entryAt: at, rawEntry: raw,
      executionEntry: execution, contracts: sizing.contracts, equityBefore: equity,
      marginUsd: sizing.margin, notionalUsd: sizing.notional, mfeBtc: 0, maeBtc: 0 };
    this.state.open = position;
    return position;
  }
  private close(at: number, raw: number, mark: number, reason: ClosedPosition['exitReason']): ClosedPosition {
    const p = this.state.open;
    if (!p) throw new Error('No position');
    const result = settle(p.contracts, p.rawEntry, raw, p.side);
    this.state.balanceBtc += result.grossBtc - result.slippageBtc - result.exitFeeBtc;
    this.state.open = null;
    const equity = this.state.balanceBtc * mark;
    const dd = this.drawdown.observe(equity);
    this.state.peakEquity = dd.peak; this.state.mdd = dd.mdd;
    const closed: ClosedPosition = { ...p, exitAt: at, rawExit: raw, executionExit: result.exitExecution,
      exitReason: reason, grossBtc: result.grossBtc, netBtc: result.netBtc,
      netUsd: result.netUsdAtExit, feesBtc: result.entryFeeBtc + result.exitFeeBtc,
      slippageBtc: result.slippageBtc, equityAfter: equity, peakEquity: dd.peak,
      drawdownPct: dd.current };
    this.state.closed.push(closed);
    return closed;
  }
}
