import { isAbsolute, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { readFile } from 'node:fs/promises';
import { FROZEN } from '../config/frozen.js';
import { PostgresHourlyClaim } from '../db/repositories/hourly.js';
import { MarketReadRepository } from '../db/repositories/market-read.js';
import { poolForRole } from '../db/postgres.js';
import { verifyShadowDbPreflight } from '../db/shadow-preflight.js';
import { FrozenModelClient } from '../inference/model-client.js';
import { MarketRuntime } from '../market/market-runtime.js';
import { HourlyScheduler } from '../report/hourly-scheduler.js';
import { HourlyMailer, validateHourlyEnvironment } from '../report/mailer.js';
import { ShadowSnapshotProvider } from '../report/shadow-snapshot.js';
import { ShadowStateStore } from './state-store.js';
import { ShadowPersistentRuntime } from './persistent-runtime.js';

export interface ShadowLaunchConfig {
  activationId: string;
  pythonExecutable: string;
  researchRoot: string;
  policyApprovalPath: string;
  lotSize: number;
}

/** Human approval to change research policy does not itself authorize runtime startup. */
export function validateShadowRuntimeApproval(raw: unknown): void {
  if (!raw || typeof raw !== 'object')
    throw new Error('Shadow runtime policy approval missing');
  const p = raw as Record<string, unknown>;
  if (
    p.policy !== 'FORWARD_SHADOW' ||
    p.policy_transition !== 'APPROVED_BY_HUMAN' ||
    p.historical_strategy_gate !== 'PASS_FOR_FORWARD_SHADOW' ||
    p.runtime_start_authorized !== true ||
    p.initial_equity_usd !== FROZEN.initialEquityUsd ||
    p.isolated_allocation_rate !== FROZEN.allocationRate ||
    p.leverage !== FROZEN.leverage ||
    p.direction_actionable_threshold !== FROZEN.threshold ||
    p.exit !== 'DIRECTION_FLIP_OR_5M_HORIZON' ||
    p.taker_fee_per_leg !== FROZEN.feeRate ||
    p.adverse_slippage_per_leg !== FROZEN.adverseSlippage ||
    p.actual_orders_allowed !== false ||
    p.private_api_allowed !== false ||
    p.api_keys_allowed !== false
  ) {
    throw new Error(
      'Shadow runtime policy is not explicitly authorized and frozen',
    );
  }
}

/** Explicit per-activation consent; PM2 template has none of these values and cannot launch by default. */
export function parseShadowLaunchConfig(
  env: NodeJS.ProcessEnv,
): ShadowLaunchConfig {
  const activationId = env.SHADOW_ACTIVATION_ID;
  if (
    !activationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      activationId,
    ) ||
    env.SHADOW_LAUNCH_APPROVAL !== activationId
  ) {
    throw new Error(
      'Explicit Shadow launch approval must match an existing activation UUID',
    );
  }
  const pythonExecutable = env.PYTHON_EXECUTABLE;
  const researchRoot = env.PYTHON_RESEARCH_ROOT;
  const policyApprovalPath = env.SHADOW_POLICY_APPROVAL_PATH;
  if (
    !pythonExecutable ||
    !isAbsolute(pythonExecutable) ||
    !researchRoot ||
    !isAbsolute(researchRoot) ||
    !policyApprovalPath ||
    !isAbsolute(policyApprovalPath)
  ) {
    throw new Error('Absolute frozen Python paths required');
  }
  const lotSize = Number(env.BTCUSD_INVERSE_LOT_SIZE);
  if (!Number.isSafeInteger(lotSize) || lotSize < 1) {
    throw new Error('Verified inverse contract lot size required');
  }
  return {
    activationId,
    pythonExecutable,
    researchRoot,
    policyApprovalPath,
    lotSize,
  };
}

/** No activation creation, canonical writer, private API, or order client exists in this path. */
export async function launchRestoredShadow(): Promise<void> {
  if (userInfo().username !== 'bybit_shadow')
    throw new Error('bybit_shadow OS user required');
  const config = parseShadowLaunchConfig(process.env);
  validateShadowRuntimeApproval(
    JSON.parse(await readFile(config.policyApprovalPath, 'utf8')) as unknown,
  );
  validateHourlyEnvironment(process.env);
  const pool = poolForRole('bybit_shadow');
  const mailer = new HourlyMailer(new PostgresHourlyClaim(pool));
  const modelFile = resolve(
    config.researchRoot,
    'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib',
  );
  const model = new FrozenModelClient(
    config.pythonExecutable,
    resolve(process.cwd(), 'python/frozen_inference_worker.py'),
    modelFile,
  );
  let hourly: HourlyScheduler | null = null;
  const runtime = new ShadowPersistentRuntime(
    new MarketRuntime('DRY_RUN'),
    new MarketReadRepository(pool),
    model,
    new ShadowStateStore(pool),
    config.activationId,
    config.lotSize,
    () => verifyShadowDbPreflight(pool),
    () => {
      hourly?.stop();
      process.exitCode = 1;
      void pool.end().catch(() => {
        process.exitCode = 1;
      });
    },
  );
  try {
    await mailer.verifyConnection();
    await runtime.start();
    hourly = new HourlyScheduler(new ShadowSnapshotProvider(
      () => runtime.committedState(), () => runtime.reportSource(),
      () => runtime.latestSignal()), mailer, (error) => runtime.halt(error));
    hourly.start();
  } catch (error) {
    hourly?.stop();
    runtime.stop();
    await pool.end();
    throw error;
  }
  const shutdown = () => {
    hourly?.stop();
    runtime.stop();
    void pool.end().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
