import { describe, expect, it } from 'vitest';
import { parseShadowLaunchConfig } from '../src/shadow/launch.js';

const activationId = '00000000-0000-4000-8000-000000000001';
const valid = {
  SHADOW_ACTIVATION_ID: activationId,
  SHADOW_LAUNCH_APPROVAL: activationId,
  PYTHON_EXECUTABLE: '/opt/cryptoTrade-python/bin/python',
  PYTHON_RESEARCH_ROOT: '/opt/btcMarketData-frozen',
  BTCUSD_INVERSE_LOT_SIZE: '1',
};

describe('explicit restored Shadow launch gate', () => {
  it('accepts only a matching activation approval and explicit inverse lot', () => {
    expect(parseShadowLaunchConfig(valid)).toEqual({
      activationId,
      pythonExecutable: valid.PYTHON_EXECUTABLE,
      researchRoot: valid.PYTHON_RESEARCH_ROOT,
      lotSize: 1,
    });
  });
  it('rejects PM2 defaults, mismatched approval, relative paths, and unspecified lot', () => {
    expect(() => parseShadowLaunchConfig({})).toThrow('approval');
    expect(() =>
      parseShadowLaunchConfig({ ...valid, SHADOW_LAUNCH_APPROVAL: 'wrong' }),
    ).toThrow('approval');
    expect(() =>
      parseShadowLaunchConfig({
        ...valid,
        PYTHON_RESEARCH_ROOT: '../research',
      }),
    ).toThrow('Absolute');
    expect(() =>
      parseShadowLaunchConfig({ ...valid, BTCUSD_INVERSE_LOT_SIZE: '' }),
    ).toThrow('lot size');
  });
});
