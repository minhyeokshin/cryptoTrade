import { isAbsolute, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { MarketReadRepository } from '../db/repositories/market-read.js';
import { poolForRole } from '../db/postgres.js';
import { verifyShadowDbPreflight } from '../db/shadow-preflight.js';
import { FrozenModelClient } from '../inference/model-client.js';
import { MarketRuntime } from '../market/market-runtime.js';
import { ShadowStateStore } from './state-store.js';
import { ShadowPersistentRuntime } from './persistent-runtime.js';

export interface ShadowLaunchConfig {
  activationId: string;
  pythonExecutable: string;
  researchRoot: string;
  lotSize: number;
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
  if (
    !pythonExecutable ||
    !isAbsolute(pythonExecutable) ||
    !researchRoot ||
    !isAbsolute(researchRoot)
  ) {
    throw new Error('Absolute frozen Python paths required');
  }
  const lotSize = Number(env.BTCUSD_INVERSE_LOT_SIZE);
  if (!Number.isSafeInteger(lotSize) || lotSize < 1) {
    throw new Error('Verified inverse contract lot size required');
  }
  return { activationId, pythonExecutable, researchRoot, lotSize };
}

/** No activation creation, canonical writer, private API, or order client exists in this path. */
export async function launchRestoredShadow(): Promise<void> {
  if (userInfo().username !== 'bybit_shadow')
    throw new Error('bybit_shadow OS user required');
  const config = parseShadowLaunchConfig(process.env);
  const pool = poolForRole('bybit_shadow');
  const modelFile = resolve(
    config.researchRoot,
    'reports/predictability_bybit_direction_exit_v1/direction_5m.joblib',
  );
  const model = new FrozenModelClient(
    config.pythonExecutable,
    resolve(process.cwd(), 'python/frozen_inference_worker.py'),
    modelFile,
  );
  const runtime = new ShadowPersistentRuntime(
    new MarketRuntime('DRY_RUN'),
    new MarketReadRepository(pool),
    model,
    new ShadowStateStore(pool),
    config.activationId,
    config.lotSize,
    () => verifyShadowDbPreflight(pool),
    () => {
      process.exitCode = 1;
      void pool.end().catch(() => {
        process.exitCode = 1;
      });
    },
  );
  try {
    await runtime.start();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const shutdown = () => {
    runtime.stop();
    void pool.end().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
