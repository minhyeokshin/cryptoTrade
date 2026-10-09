import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { ProducerLease } from '../../dist/db/producer-lease.js';
import { WsJournal } from '../../dist/db/repositories/ws-journal.js';
import { MarketRepository } from '../../dist/db/repositories/market.js';
import { normalizeWsTrade } from '../../dist/market/trade-normalizer.js';
import { encodeJournalFrame } from '../../dist/market/journal-frame.js';
import { aggregate } from '../../dist/market/candle-builder.js';
import { orderReplay } from '../../dist/market/replay-order.js';

assert.match(process.env.PG_CLUSTER_CONF_ROOT ?? '', /^\/tmp\/pg_virtualenv\.[^/]+\/postgresql$/);
assert.notEqual(process.env.PGPORT, '5432');
const database='journal_isolated';
const admin=new pg.Pool({ database, host:'/tmp', user:process.env.PGUSER });
const pool=new pg.Pool({ database, host:'127.0.0.1', user:'bybit_producer' });
pool.on('error',()=>{}); // Expected backend termination fault injection; never dump connection objects.
let lease;
let passed=0;
const pass=(name)=>{passed++; console.log(`PASS ${name}`);};
function batch(connection=randomUUID(), ordinal=1, first=1, names=['z','a']) {
 const rawMessage=JSON.stringify({topic:'publicTrade.BTCUSD',data:names.map((i,n)=>({
  i,s:'BTCUSD',T:60001,seq:9,p:String(101+n),v:String(n+1),S:'Buy'}))});
 return JSON.parse(rawMessage).data.map((t,n)=>({...normalizeWsTrade(t,60002),witness:{
  connectionId:connection,messageOrdinal:ordinal,messageIndex:n,receiveOrder:first+n,
  receivedAt:60002,exchangeMessageId:null,rawMessage,
  messageHash:createHash('sha256').update(rawMessage).digest('hex')}}));
}
try {
 const version=await admin.query('SHOW server_version_num');
 assert.ok(Number(version.rows[0].server_version_num)>=160000 && Number(version.rows[0].server_version_num)<170000);
 lease=await ProducerLease.acquire(pool);await lease.resumeApprovedEpoch();
 let journal=new WsJournal(lease);
 const trades=batch();
 // Arrival without commit cannot be replayed; a committed journal survives client death.
 assert.equal((await journal.replay(60000)).length,0);pass('receive-before-commit has no false durable evidence');
 await journal.append(trades);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.bybit_live_trades')).rows[0].n,0);
 const pid=(await lease.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 lease.client.on('error',()=>{});
 await admin.query('SELECT pg_terminate_backend($1)',[pid]);
 lease.client.release(true);lease=undefined;
 lease=await ProducerLease.acquire(pool);await lease.resumeApprovedEpoch();journal=new WsJournal(lease);
 const replay=await journal.replay(60000);
 assert.deepEqual(orderReplay(replay,replay),trades);pass('journal commit survives backend termination before canonical commit');
 await journal.append(trades);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.node_ws_journal_frames')).rows[0].n,1);
 pass('same frame retry idempotent');
 await journal.append(batch(trades[0].witness.connectionId,2,3));
 const duplicateReplay=await journal.replay(60000);
 assert.equal(duplicateReplay.length,4);
 assert.deepEqual(orderReplay(duplicateReplay,duplicateReplay).map(t=>t.id),['z','a']);
 pass('duplicate WS payload preserves occurrences but canonical replay IDs deduplicate');
 await assert.rejects(journal.append(trades.slice(0,1)));pass('partial frame rejected');
 const missing=batch();
 await assert.rejects(new MarketRepository(pool,lease).persist(aggregate(missing,120000,'100'),missing),/lacks committed journal/);
 pass('canonical requires committed complete frame');
 // Inject a database failure after raw message INSERT. No partial raw frame survives rollback.
 await admin.query(`CREATE FUNCTION bybit_live.inject_fault() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'injected journal write failure'; END $$;
 CREATE TRIGGER inject_failure BEFORE INSERT ON bybit_live.node_ws_journal_frames
 FOR EACH ROW EXECUTE FUNCTION bybit_live.inject_fault()`);
 const rejected=batch();await assert.rejects(journal.append(rejected),/injected journal/);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.node_ws_messages WHERE connection_id=$1',
  [rejected[0].witness.connectionId])).rows[0].n,0);
 await admin.query('DROP TRIGGER inject_failure ON bybit_live.node_ws_journal_frames');
 pass('journal DB failure atomically rolls back raw message');
 // Bad evidence injected by isolated fixture administrator, never production.
 const tampered=batch();const f=encodeJournalFrame(tampered);
 await admin.query(`INSERT INTO bybit_live.node_ws_messages VALUES($1,1,to_timestamp(60.002),NULL,$2,$3)`,
 [f.connectionId,f.messageHash,f.rawMessage]);
 await admin.query(`INSERT INTO bybit_live.node_ws_journal_frames
 (connection_id,message_ordinal,epoch_id,first_receive_order,trade_count,min_timestamp,max_timestamp,witnesses)
 VALUES($1,1,'11111111-1111-4111-8111-111111111111',1,2,60001,60001,'[[],[]]'::jsonb)`,[f.connectionId]);
 await assert.rejects(journal.replay(60000),/witness coverage/);pass('stored witness tampering fails replay');
 // Canonical persistence of the original independently valid frame still verifies itself.
 const candle=aggregate(trades,120000,'100');
 assert.deepEqual([candle.open,candle.high,candle.low,candle.close,candle.volume],['100','102','100','102','3']);
 const market=new MarketRepository(pool,lease);
 await admin.query(`CREATE TRIGGER inject_canonical_failure BEFORE INSERT ON bybit_live.bybit_live_candles_1m
 FOR EACH ROW EXECUTE FUNCTION bybit_live.inject_fault()`);
 await assert.rejects(market.persist(candle,trades),/injected journal write failure/);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.bybit_live_trades')).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.node_ws_trade_witnesses')).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.node_ws_journal_frames WHERE connection_id=$1',
  [trades[0].witness.connectionId])).rows[0].n,2);
 await admin.query('DROP TRIGGER inject_canonical_failure ON bybit_live.bybit_live_candles_1m');
 pass('canonical pre-commit failure rolls back canonical but preserves prior journal');
 await Promise.all([market.persist(candle,trades),journal.append(trades)]);
 await market.persist(candle,trades);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.bybit_live_trades')).rows[0].n,2);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM bybit_live.bybit_live_candles_1m')).rows[0].n,1);
 pass('journal/canonical transactions serialized; repeated canonical commit duplicates zero');
 await assert.rejects(pool.query('DELETE FROM bybit_live.node_ws_journal_frames'),/permission denied/);
 await assert.rejects(admin.query('UPDATE bybit_live.node_ws_journal_frames SET trade_count=trade_count'),/append only/);
 pass('append-only grants and triggers');
 console.log(`POSTGRES_JOURNAL_INTEGRATION=${passed}/${passed} PASS (isolated PostgreSQL 16)`);
} finally {
 if(lease) await lease.release();
 await pool.end();await admin.end();
}
