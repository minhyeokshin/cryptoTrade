import { FROZEN } from '../config/frozen.js';
import type { Side } from '../types/domain.js';

export function executionPrice(raw: number, side: Side, entry: boolean): number {
  if (!Number.isFinite(raw) || raw <= 0) throw new Error('Invalid price');
  const sign = side === 'LONG' ? 1 : -1;
  return raw * (1 + (entry ? sign : -sign) * FROZEN.adverseSlippage);
}

export function grossBtc(contracts: number, entry: number, exit: number, side: Side): number {
  if (![contracts, entry, exit].every((x) => Number.isFinite(x) && x > 0)) throw new Error('Invalid inverse input');
  return (side === 'LONG' ? 1 : -1) * contracts * (1 / entry - 1 / exit);
}

export interface Settlement {
  entryExecution: number; exitExecution: number; grossBtc: number;
  slippageBtc: number; entryFeeBtc: number; exitFeeBtc: number;
  netBtc: number; netUsdAtExit: number;
}

export function settle(contracts: number, entryRaw: number, exitRaw: number, side: Side): Settlement {
  const en = executionPrice(entryRaw, side, true);
  const ex = executionPrice(exitRaw, side, false);
  const gross = grossBtc(contracts, entryRaw, exitRaw, side);
  const afterSlip = grossBtc(contracts, en, ex, side);
  const entryFee = FROZEN.feeRate * contracts / en;
  const exitFee = FROZEN.feeRate * contracts / ex;
  const net = afterSlip - entryFee - exitFee;
  return { entryExecution: en, exitExecution: ex, grossBtc: gross,
    slippageBtc: gross - afterSlip, entryFeeBtc: entryFee, exitFeeBtc: exitFee,
    netBtc: net, netUsdAtExit: net * ex };
}

export function inverseContracts(equityUsd: number, lotSize: number): { margin: number; notional: number; contracts: number } {
  if (equityUsd <= 0 || !Number.isFinite(equityUsd) || !Number.isInteger(lotSize) || lotSize < 1) throw new Error('Invalid sizing');
  const margin = equityUsd * FROZEN.allocationRate;
  const notional = margin * FROZEN.leverage;
  return { margin, notional, contracts: Math.floor(notional / lotSize) * lotSize };
}
