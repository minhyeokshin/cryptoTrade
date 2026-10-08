import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { BybitPublicWs } from '../src/market/bybit-ws.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sends: string[] = [];
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  send(value: string): void { this.sends.push(value); }
  ping(): void {}
}

describe('public WebSocket generation safety', () => {
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
    expect(() => ws.start()).toThrow('already started');
    ws.stop();
    ws.start();
    const current = sockets[1]!;
    current.emit('open');
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
