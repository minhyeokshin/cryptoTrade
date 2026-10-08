export const FROZEN = Object.freeze({
  symbol: 'BTCUSD', category: 'inverse',
  initialEquityUsd: 100, allocationRate: 0.20, leverage: 1.8,
  threshold: 0.55, horizonMs: 5 * 60_000,
  feeRate: 0.00055, adverseSlippage: 0.0002,
  directionModelHash: '5f04ee01a58e0593ef9517077d0bdc5b5fa45c7894d8b08d11ce12ee08a20dd0',
  featureSchemaHash: 'af7e98f5d75568be4a2ed69fa8fda70542304a7197f79cfa14d396b1cd0a238f',
  thresholdHash: '8767d3648018e7bdb0f0284a5e825958a22d62ed005e3e15d6ee57906f7e46af',
  strategyVersion: 'frozen-direction-5m-flip-v1',
});

export function assertFrozenEnvironment(env: NodeJS.ProcessEnv): void {
  const checks: Record<string, number> = {
    INITIAL_EQUITY_USD: FROZEN.initialEquityUsd,
    ALLOCATION_RATE: FROZEN.allocationRate,
    LEVERAGE: FROZEN.leverage,
    DIRECTION_THRESHOLD: FROZEN.threshold,
  };
  for (const [key, value] of Object.entries(checks)) {
    if (env[key] !== undefined && Number(env[key]) !== value) {
      throw new Error(`Frozen setting mismatch: ${key}`);
    }
  }
}
