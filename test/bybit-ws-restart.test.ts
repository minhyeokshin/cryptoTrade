import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BybitPublicWs } from '../src/market/bybit-ws.js';
import type { CanonicalTrade } from '../src/types/domain.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sends: string[] = [];
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  send(value: string): void { this.sends.push(value); }
  ping(): void {}
}

describe('public WebSocket generation safety', () => {
  it('captures original frame order for trades sharing timestamp and sequence', () => {
    const socket = new FakeSocket();
    const ws = new BybitPublicWs(undefined, () => socket as unknown as WebSocket);
    const trades: CanonicalTrade[] = [];
    ws.on('trade', (trade: CanonicalTrade) => trades.push(trade));
    ws.start(); socket.emit('open');
    socket.emit('message', JSON.stringify({ op: 'subscribe', success: true }));
    socket.emit('message', JSON.stringify({ topic: 'publicTrade.BTCUSD', data: [
      { s: 'BTCUSD', i: 'b', S: 'Buy', p: '101', v: '2', T: '1791435000000', seq: 9 },
      { s: 'BTCUSD', i: 'a', S: 'Buy', p: '102', v: '3', T: '1791435000000', seq: 9 },
    ] }));
    socket.emit('message', JSON.stringify({ topic: 'publicTrade.BTCUSD', data: [
      { s: 'BTCUSD', i: 'c', S: 'Buy', p: '103', v: '4', T: '1791435000000', seq: 9 },
    ] }));
    expect(trades.map((trade) => trade.id)).toEqual(['b', 'a', 'c']);
    expect(trades.map((trade) => trade.witness?.receiveOrder)).toEqual([1, 2, 3]);
    expect(trades.map((trade) => trade.witness?.messageOrdinal)).toEqual([1, 1, 2]);
    expect(trades.map((trade) => trade.witness?.messageIndex)).toEqual([0, 1, 0]);
    expect(trades[0]?.witness?.connectionId).toBe(trades[2]?.witness?.connectionId);
    ws.stop();
  });
  it('requires a real successful subscription response, not just socket open or trade', () => {
    const socket = new FakeSocket();
    const ws = new BybitPublicWs(undefined, () => socket as unknown as WebSocket);
    ws.on('error', () => {});
    ws.start(); socket.emit('open');
    expect(ws.subscribed).toBe(false);
    socket.emit('message', JSON.stringify({ op: 'subscribe', success: false }));
    expect(ws.subscribed).toBe(false);
    socket.emit('message', JSON.stringify({ op: 'subscribe', success: true }));
    expect(ws.subscribed).toBe(true);
    ws.stop();
  });
  it('ignores delayed events from a stopped socket after immediate restart', () => {
    const sockets: FakeSocket[] = [];
    const ws = new BybitPublicWs(undefined, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    let disconnected = 0;
    let trades = 0;
    ws.on('disconnected', () => disconnected++);
    ws.on('trade', () => trades++);
    ws.start();
    const old = sockets[0]!;
    old.emit('open');
    expect(ws.connected).toBe(true);
    expect(ws.subscribed).toBe(false);
    expect(() => ws.start()).toThrow('already started');
    ws.stop();
    ws.start();
    const current = sockets[1]!;
    current.emit('open');
    current.emit('message', JSON.stringify({ op: 'subscribe', success: true }));
    expect(ws.subscribed).toBe(true);
    old.emit('close');
    const payload = JSON.stringify({ topic: 'publicTrade.BTCUSD', data: [
      { s: 'BTCUSD', i: 'trade-1', S: 'Buy', p: '100000', v: '1', T: '1791435000000', seq: 1 },
    ] });
    old.emit('message', payload);
    old.emit('pong');
    expect(ws.connected).toBe(true);
    expect(disconnected).toBe(0);
    expect(trades).toBe(0);
    current.emit('message', payload);
    expect(trades).toBe(1);
    expect(ws.reconnectCount).toBe(0);
    expect(sockets).toHaveLength(2);
    ws.stop();
    expect(ws.subscribed).toBe(false);
  });

  it('reconnects once after a current socket closes', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const ws = new BybitPublicWs(undefined, () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      });
      ws.start();
      sockets[0]!.emit('open');
      sockets[0]!.close();
      expect(ws.connected).toBe(false);
      expect(ws.reconnectCount).toBe(1);
      vi.advanceTimersByTime(2000);
      expect(sockets).toHaveLength(2);
      sockets[1]!.emit('open');
      expect(ws.connected).toBe(true);
      ws.stop();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
