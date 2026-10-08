export function sourceFresh(now: number, lastTrade: number | null, lastCandle: number | null,
  connected: boolean, continuity: boolean): boolean {
  return connected && continuity && lastTrade !== null && lastCandle !== null &&
    now >= lastTrade && now - lastTrade < 180_000 && now >= lastCandle && now - lastCandle < 180_000;
}
