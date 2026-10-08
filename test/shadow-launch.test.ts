import { describe, expect, it } from 'vitest';
import {
  parseShadowLaunchConfig,
  validateShadowRuntimeApproval,
} from '../src/shadow/launch.js';

const activationId = '00000000-0000-4000-8000-000000000001';
const valid = {
  SHADOW_ACTIVATION_ID: activationId,
  SHADOW_LAUNCH_APPROVAL: activationId,
  PYTHON_EXECUTABLE: '/opt/cryptoTrade-python/bin/python',
  PYTHON_RESEARCH_ROOT: '/opt/btcMarketData-frozen',
  SHADOW_POLICY_APPROVAL_PATH:
    '/opt/btcMarketData-frozen/reports/bybit_live/forward_shadow_policy_approval_v2.json',
  BTCUSD_INVERSE_LOT_SIZE: '1',
};

describe('explicit restored Shadow launch gate', () => {
  it('accepts only a matching activation approval and explicit inverse lot', () => {
    expect(parseShadowLaunchConfig(valid)).toEqual({
      activationId,
      pythonExecutable: valid.PYTHON_EXECUTABLE,
      researchRoot: valid.PYTHON_RESEARCH_ROOT,
      policyApprovalPath: valid.SHADOW_POLICY_APPROVAL_PATH,
      lotSize: 1,
    });
  });
  it('refuses the existing policy-transition artifact because runtime start is not authorized', () => {
    const policy = {
      policy: 'FORWARD_SHADOW',
      policy_transition: 'APPROVED_BY_HUMAN',
      historical_strategy_gate: 'PASS_FOR_FORWARD_SHADOW',
      runtime_start_authorized: false,
      initial_equity_usd: 100,
      isolated_allocation_rate: 0.2,
      leverage: 1.8,
      direction_actionable_threshold: 0.55,
      exit: 'DIRECTION_FLIP_OR_5M_HORIZON',
      taker_fee_per_leg: 0.00055,
      adverse_slippage_per_leg: 0.0002,
      actual_orders_allowed: false,
      private_api_allowed: false,
      api_keys_allowed: false,
    };
    expect(() => validateShadowRuntimeApproval(policy)).toThrow(
      'not explicitly authorized',
    );
    expect(() =>
      validateShadowRuntimeApproval({
        ...policy,
        runtime_start_authorized: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateShadowRuntimeApproval({
        ...policy,
        runtime_start_authorized: true,
        direction_actionable_threshold: 0.54,
      }),
    ).toThrow('not explicitly authorized');
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
