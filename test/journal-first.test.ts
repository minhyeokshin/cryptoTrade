import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type WebSocket from 'ws';
import { BybitPublicWs } from '../src/market/bybit-ws.js';
import { encodeJournalFrame, decodeJournalFrame } from '../src/market/journal-frame.js';
import { normalizeWsTrade } from '../src/market/trade-normalizer.js';
import { reconcileRecent } from '../src/market/reconcile.js';
import { orderReplay } from '../src/market/replay-order.js';
import { aggregate, CandleBuilder } from '../src/market/candle-builder.js';
import type { CanonicalTrade } from '../src/types/domain.js';
import { MarketRuntime } from '../src/market/market-runtime.js';
import type { MarketRepository } from '../src/db/repositories/market.js';

const raw = JSON.stringify({ topic:'publicTrade.BTCUSD', data:[
  { s:'BTCUSD', i:'z', S:'Buy', p:'101', v:'382', T:60001, seq:9 },
  { s:'BTCUSD', i:'a', S:'Buy', p:'102', v:'500', T:60001, seq:9 },
] });
function sample(): CanonicalTrade[] {
  return (JSON.parse(raw).data as unknown[]).map((t,i) => ({ ...normalizeWsTrade(t,60002), witness:{
    connectionId:'11111111-1111-4111-8111-111111111111', messageOrdinal:1,
    messageIndex:i,receiveOrder:i+1,receivedAt:60002,exchangeMessageId:null,
    rawMessage:raw,messageHash:createHash('sha256').update(raw).digest('hex'),
  } }));
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
class Socket extends EventEmitter {
  close(): void { this.emit('close'); }
  send(): void {}
  ping(): void {}
}
describe('journal-first crash boundary and proof', () => {
  it('restart runtime consumes committed journal ties in source order before the next verified candle', async () => {
    vi.useFakeTimers();vi.setSystemTime(65000);
    const socket=new Socket();
    const liveRaw={s:'BTCUSD',i:'live',S:'Buy',p:'103',v:'1',T:61000,seq:10};
    const ws=new BybitPublicWs(undefined,()=>{
      queueMicrotask(()=>{socket.emit('open');
        socket.emit('message',JSON.stringify({op:'subscribe',success:true}));
        socket.emit('message',JSON.stringify({topic:'publicTrade.BTCUSD',data:[liveRaw]}));});
      return socket as unknown as WebSocket;
    });
    const anchor={...normalizeWsTrade(liveRaw,65000),id:'anchor',timestamp:59999,sequence:8,
      source:'REST_RECENT' as const};
    const official={end:120000,open:'100',high:'103',low:'100',close:'103',volume:'883',
      tradeCount:3,firstTradeTimestamp:60001,lastTradeTimestamp:61000};
    const persisted=vi.fn(async()=>{}),durable:CanonicalTrade[]=[];
    const repository={journalFrame:async(t:CanonicalTrade[])=>{durable.push(...t);},
      replayJournal:async()=>[...sample(),...durable],verifyPersistedWsWitnesses:async()=>{},
      recoveryTail:async()=>({lastCandleEnd:60000,previousClose:'100',lastTrade:anchor,
        anchorTimestampTrades:[anchor],unfinalizedTrades:[]}),recordStartupHealth:async()=>{},
      recordFailure:async()=>{},persist:persisted} as unknown as MarketRepository;
    const runtime=new MarketRuntime('WRITE',repository,ws,{
      recentTrades:async()=>[{...anchor,id:'before',timestamp:59998},anchor,...sample().reverse(),
        normalizeWsTrade(liveRaw,65000)],officialOneMinute:async()=>official});
    try {
      const start=runtime.start();await vi.advanceTimersByTimeAsync(100);await start;
      expect(runtime.status().recoveredTrades).toBe(2);
      await vi.advanceTimersByTimeAsync(58000);
      expect(persisted).toHaveBeenCalledTimes(1);
      const call=persisted.mock.calls[0] as unknown as [unknown,CanonicalTrade[]];
      expect(call[0]).toEqual(official);
      expect(call[1].map(t=>t.id)).toEqual(['z','a','live']);
    } finally {runtime.stop();vi.useRealTimers();}
  });
  it('withholds canonical delivery until journal commit; stop after receive never delivers', async () => {
    const socket=new Socket(), ws=new BybitPublicWs(undefined,()=>socket as unknown as WebSocket);
    let commit!: () => void;
    const delivered: CanonicalTrade[]=[];
    ws.setFrameCommitter(()=>new Promise<void>((resolve)=>{commit=resolve;}));
    ws.on('trade',(t)=>delivered.push(t)); ws.on('error',()=>{});
    ws.start();socket.emit('open');socket.emit('message',raw);
    await flush(); expect(delivered).toHaveLength(0);
    ws.stop();commit();await flush();expect(delivered).toHaveLength(0);
  });
  it('delivers whole frames serially only after commit', async () => {
    const socket=new Socket(), ws=new BybitPublicWs(undefined,()=>socket as unknown as WebSocket);
    const events:string[]=[];
    ws.setFrameCommitter(async(t)=>{events.push(`commit${t[0]!.witness!.messageOrdinal}`);});
    ws.on('trade',(t:CanonicalTrade)=>events.push(`${t.witness!.messageOrdinal}:${t.id}`));
    ws.on('error',()=>{});ws.start();socket.emit('open');
    socket.emit('message',raw);socket.emit('message',raw);await flush();ws.stop();
    expect(events).toEqual(['commit1','1:z','1:a','commit2','2:z','2:a']);
  });
  it('journal write failure stops the socket and never publishes later queued frames', async () => {
    const socket=new Socket(),ws=new BybitPublicWs(undefined,()=>socket as unknown as WebSocket);
    const delivered:unknown[]=[],errors:unknown[]=[];
    ws.setFrameCommitter(async()=>{throw new Error('DB journal failure');});
    ws.on('trade',(t)=>delivered.push(t));ws.on('error',(e)=>errors.push(e));
    ws.start();socket.emit('open');socket.emit('message',raw);socket.emit('message',raw);
    await flush();expect(delivered).toHaveLength(0);expect(ws.connected).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
  it('replays after journal commit / before canonical commit with exact source order and candle parity', () => {
    const frame=encodeJournalFrame(sample());
    const replay=decodeJournalFrame(JSON.parse(JSON.stringify(frame)));
    const anchor={...replay[0]!,id:'anchor',timestamp:59999,sequence:8,source:'REST_RECENT' as const};
    const before={...anchor,id:'before',timestamp:59998};
    const live={...anchor,id:'live',timestamp:61000,sequence:10};
    const rest=[live,...[...replay].reverse().map(t=>({...t,source:'REST_RECENT' as const,witness:undefined})),anchor,before];
    const result=reconcileRecent(anchor,rest,[live],[anchor],replay);
    expect(result.recovered.map(t=>t.id)).toEqual(['z','a']);
    expect(aggregate(result.recovered,120000,'100')).toEqual(aggregate(sample(),120000,'100'));
    const builder=new CandleBuilder();replay.forEach(t=>builder.ingest(t));
    replay.forEach(t=>expect(builder.ingest(t)).toBe('DUPLICATE'));
    const official={end:120000,open:'100',high:'102',low:'100',close:'102',volume:'882',
      tradeCount:2,firstTradeTimestamp:60001,lastTradeTimestamp:60001};
    expect(builder.finalize(120000,123000,'100',official)).toEqual(official);
  });
  it('rejects partial frame, missing witness, hash and witness tampering', () => {
    const frame=encodeJournalFrame(sample());
    expect(()=>encodeJournalFrame(sample().slice(0,1))).toThrow();
    expect(()=>encodeJournalFrame([{...sample()[0]!,witness:undefined}])).toThrow();
    expect(()=>decodeJournalFrame({...frame,messageHash:'0'.repeat(64)})).toThrow();
    expect(()=>decodeJournalFrame({...frame,witnesses:[]})).toThrow();
    expect(()=>decodeJournalFrame({...frame,firstReceiveOrder:2})).toThrow();
  });
  it('does not infer a REST-only tied group order or combine partial connections', () => {
    const trades=sample();
    expect(()=>orderReplay(trades,[])).toThrow('Incomplete journal');
    const partial=[trades[0]!,{...trades[1]!,witness:{...trades[1]!.witness!,
      connectionId:'22222222-2222-4222-8222-222222222222'}}];
    expect(()=>orderReplay(trades,partial)).toThrow('Incomplete journal');
  });
  it('rejects payload mismatch and deduplicates exact IDs without lexical sorting', () => {
    const trades=sample();
    expect(orderReplay([...trades].reverse().concat(trades),trades).map(t=>t.id)).toEqual(['z','a']);
    expect(()=>orderReplay([{...trades[0]!,price:'999'},trades[1]!],trades)).toThrow('payload');
  });
});
