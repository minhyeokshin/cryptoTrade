/** Read-only replay of the actual persisted tail against current official public REST/WS. */
import { userInfo } from 'node:os';
import { poolForReadOnlyRole } from './db/postgres.js';
import { MarketRepository } from './db/repositories/market.js';
import { recentTrades } from './market/bybit-rest.js';
import { BybitPublicWs } from './market/bybit-ws.js';
import { reconcileRecent, ReconciliationEvidenceError } from './market/reconcile.js';
import { sameTrade } from './market/trade-normalizer.js';
import type { CanonicalTrade } from './types/domain.js';

if (userInfo().username !== 'bybit_producer') throw new Error('bybit_producer OS user required');
const pool = poolForReadOnlyRole('bybit_producer');
const ws = new BybitPublicWs();
const buffered = new Map<string, CanonicalTrade>();
let orderingViolations = 0;
let previousTimestamp = -Infinity;
ws.on('trade', (trade: CanonicalTrade) => {
  if (trade.timestamp < previousTimestamp) orderingViolations++;
  previousTimestamp = Math.max(previousTimestamp, trade.timestamp);
  const old = buffered.get(trade.id);
  if (old && !sameTrade(old, trade)) throw new Error('Conflicting WS trade ID');
  if (!old) buffered.set(trade.id, trade);
});

try {
  const tail = await new MarketRepository(pool).recoveryTail();
  ws.start();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('connected', ready); ws.off('subscribed', ready); ws.off('trade', ready);
      ws.off('error', failed); ws.off('disconnected', disconnected);
    };
    const ready = () => { if (ws.connected && ws.subscribed && buffered.size > 0) { cleanup(); resolve(); } };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const disconnected = () => failed(new Error('WS disconnected during forensic capture'));
    const timeout = setTimeout(() => failed(new Error('WS open/subscribe/trade timeout')), 30_000);
    ws.on('connected', ready); ws.on('subscribed', ready); ws.on('trade', ready);
    ws.once('error', failed); ws.once('disconnected', disconnected);
    ready();
  });
  // Allow a bounded post-subscription buffer; this is observation, not a canonical writer.
  await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  if (!ws.connected || !ws.subscribed) throw new Error('WS disconnected before REST comparison');
  const rest = await recentTrades();
  const restById = new Map(rest.map((trade) => [trade.id, trade]));
  const wsRows = [...buffered.values()];
  const groups = new Map<string, CanonicalTrade[]>();
  for (const trade of rest) {
    if (trade.timestamp < tail.lastTrade.timestamp) continue;
    const key = `${trade.timestamp}:${trade.sequence ?? 'NULL'}`;
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  const tiedGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  const detail = (trade: CanonicalTrade) => ({ tradeId: trade.id, timestamp: trade.timestamp,
    sequence: trade.sequence, price: trade.price, size: trade.size, side: trade.side });
  let result: ReturnType<typeof reconcileRecent> | null = null;
  let error: string | null = null;
  let failingGroup: ReconciliationEvidenceError['failingGroup'] | null = null;
  let persistedFailingGroup: Array<{ trade_id: string; exchange_timestamp: Date;
    raw_sequence: string | null; price: string; size: string; side: string }> = [];
  try { result = reconcileRecent(tail.lastTrade, rest, wsRows, tail.anchorTimestampTrades); }
  catch (cause) {
    error = String(cause);
    if (cause instanceof ReconciliationEvidenceError) {
      failingGroup = cause.failingGroup;
      const persisted = await pool.query<{ trade_id: string; exchange_timestamp: Date;
        raw_sequence: string | null; price: string; size: string; side: string }>(
        `SELECT trade_id,exchange_timestamp,raw_sequence::text,price::text,size::text,side
           FROM bybit_live.bybit_live_trades
          WHERE exchange_timestamp=to_timestamp($1::double precision/1000)
            AND raw_sequence=$2`,
        [failingGroup.timestamp, failingGroup.sequence]);
      persistedFailingGroup = persisted.rows;
    }
  }
  const overlap = wsRows.filter((trade) => {
    const witness = restById.get(trade.id);
    return witness && sameTrade(trade, witness) &&
      (trade.sequence === null || witness.sequence === null || trade.sequence === witness.sequence);
  }).length;
  process.stdout.write(`${JSON.stringify({ capturedAt: new Date().toISOString(),
    readOnly: true, postgresReadOnlyEnforced: true, canonicalWrites: 0,
    anchorTrade: detail(tail.lastTrade), anchorTimestamp: tail.lastTrade.timestamp,
    anchorSequence: tail.lastTrade.sequence, lastCandleEnd: tail.lastCandleEnd,
    persistedAnchorGroup: tail.anchorTimestampTrades.map(detail),
    sameSequenceGroupSize: Math.max(0, ...tiedGroups.map(([, rows]) => rows.length)),
    sameSequenceGroups: tiedGroups.slice(0, 10).map(([key, rows]) => ({ key,
      size: rows.length, restOrder: rows.map((trade) => trade.id),
      wsOrder: wsRows.filter((trade) => rows.some((row) => row.id === trade.id)).map((trade) => trade.id),
      trades: rows.slice(0, 40).map(detail) })),
    restRows: rest.length, wsRows: wsRows.length, restWsOverlap: overlap,
    restOlderThanAnchor: rest.filter((trade) => trade.timestamp < tail.lastTrade.timestamp).length,
    reconciliationResult: error ? 'FAIL' : 'PASS', error,
    failingGroup, persistedFailingGroup,
    missingTrades: result?.recovered.map(detail) ?? null,
    duplicateTrades: result ? result.recovered.filter((trade) =>
      tail.unfinalizedTrades.some((old) => old.id === trade.id)).length : null,
    orderingViolations }, null, 2)}\n`);
} finally { ws.stop(); await pool.end(); }
