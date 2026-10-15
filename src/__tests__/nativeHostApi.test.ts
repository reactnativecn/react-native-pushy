import { describe, expect, test } from 'bun:test';
import vectorsFile from '../../cpp/update_flow_core/tests/native-config-vectors.json';
import type { BundlePreparationResult } from '../../harmony/pushy/src/main/ets/BundlePreparationResult';
import {
  BundlePreparationRound,
  bundlePreparationResult,
} from '../../harmony/pushy/src/main/ets/BundlePreparationResult';
import { STATUS_NONE } from '../../harmony/pushy/src/main/ets/Texts';
import { evalHarmonyModule, harmonyConfigBindings } from './nativeSources';

// Evaluate the actual Harmony orchestrator in an isolated VM per test. Only
// platform imports, HTTP, download IO and the round engine are substituted
// (the engine by a scripted stand-in: the real one is pinned by
// round-engine-vectors.json, and harmonySyncRound.test.ts replays it against
// this adapter); entry points, scheduling, configuration gates, the host
// wait and reset checks are real.

interface Decision {
  action: string;
  reason?: string;
  hash?: string;
  activate?: boolean;
}

// The round the engine would run for the harness's scenario: the config
// gate, one check, then the decision, the download and the commit.
function scriptedEngine(decision: () => Decision) {
  return (stateJson: string | undefined, eventJson: string): string => {
    const event = JSON.parse(eventJson);
    const state = stateJson ? JSON.parse(stateJson) : {};
    const step = (next: object, ...commands: object[]) =>
      JSON.stringify({ state: { ...state, ...next }, commands });
    const finish = (
      status: string,
      reason = '',
      hash?: string,
      activated?: boolean
    ) =>
      step(
        { phase: 'done' },
        { type: 'finish', status, reason, hash, activated }
      );
    const commit = (hash: string, activate: boolean, result: object) =>
      step(
        { phase: 'committed', result },
        {
          type: 'commit',
          hash,
          hashInfo: hash ? '{}' : '',
          activate,
          cache: '{}',
          resetGeneration: state.resetGeneration,
        }
      );
    switch (event.type) {
      case 'start': {
        const gate = JSON.parse(
          harmonyConfigBindings.runnableConfig(event.config)
        );
        if (gate.status) {
          return finish(gate.status, gate.reason);
        }
        return JSON.stringify({
          state: { phase: 'env', resetGeneration: event.resetGeneration },
          commands: [{ type: 'markIncomplete' }, { type: 'collectEnv' }],
        });
      }
      case 'env':
        return step(
          { phase: 'http' },
          {
            type: 'http',
            url: 'https://check',
            post: true,
            body: '{}',
            timeoutMs: 10000,
            callTimeoutMs: 15000,
          }
        );
      case 'http': {
        if (event.text === undefined) {
          return finish('failed', 'check_failed');
        }
        const d = decision();
        if (d.action !== 'download') {
          return commit('', false, {
            status: STATUS_NONE,
            reason: d.reason ?? '',
          });
        }
        return step(
          { phase: 'installed', decision: d },
          { type: 'checkInstalled', hash: d.hash }
        );
      }
      case 'installed':
      case 'download': {
        const d = state.decision as Decision;
        const ready = event.type === 'installed' ? event.installed : event.ok;
        if (ready) {
          return commit(d.hash ?? '', d.activate === true, {
            status: 'downloaded',
            hash: d.hash,
            activated: d.activate === true,
          });
        }
        if (event.type === 'installed') {
          return step(
            { phase: 'download' },
            {
              type: 'download',
              strategy: 'full',
              url: 'https://cdn/full',
              hash: d.hash,
              deadline: 600000,
            }
          );
        }
        return commit('', false, {
          status: 'failed',
          reason: 'download_failed',
        });
      }
      default: {
        if (event.error) {
          return finish('failed', 'commit_failed');
        }
        if (!event.ok) {
          return finish('cancelled', event.reason ?? 'reset');
        }
        const r = state.result;
        return finish(r.status, r.reason ?? '', r.hash, r.activated);
      }
    }
  };
}

function harness() {
  const values = new Map<string, string>();
  values.set('nativeConfig', JSON.stringify({ appKey: 'test-app' }));
  const timers: Array<() => void> = [];
  const state = {
    generation: 0,
    checks: 0,
    downloads: 0,
    commits: 0,
    downloadOK: true,
    commitOK: true,
    installed: false,
    reachable: true,
    decision: { action: 'none', reason: 'up_to_date' } as Decision,
    beforeResponse: async (): Promise<void> => {},
  };
  const context = {
    getKv: (key: string) => values.get(key),
    setKv: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeKv: async (key: string) => {
      values.delete(key);
    },
    getResetGeneration: () => state.generation,
    getNativeConfigGeneration: () => 0,
    getCurrentVersion: () => '',
    getPackageVersion: () => '1.0',
    getBuildTime: () => '123',
    getBundleHash: async () => 'binary-hash',
    hasDownloadedVersion: () => state.installed,
    isStoredNativeConfig: (config: string) =>
      harmonyConfigBindings.configsEquivalent(
        config,
        values.get('nativeConfig')
      ),
    downloadFullUpdate: async () => {
      state.downloads += 1;
      if (!state.downloadOK) {
        throw new Error('download failed');
      }
    },
    getBundleUrl: () => {
      throw new Error('host checks must not resolve the launch bundle again');
    },
    commitSyncResult: async (generation: number) => {
      state.commits += 1;
      return generation === state.generation && state.commitOK;
    },
  };
  const runtime = evalHarmonyModule(
    'SyncCoordinator.ts',
    'httpRequest = mockCheck;\n({ check: prepareBundleNative, schedule: scheduleNativeSync });',
    {
      BundlePreparationRound,
      bundlePreparationResult,
      logger: { info() {}, warn() {}, error() {} },
      deviceInfo: { osFullName: 'test-os' },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => {},
      getErrorMessage: (error: unknown) => String(error),
      monotonicNowMs: () => 0,
      PushyError: class {},
      NativePatchCore: {
        ...harmonyConfigBindings,
        stepRound: scriptedEngine(() => state.decision),
      },
      mockCheck: async () => {
        state.checks += 1;
        await state.beforeResponse();
        return state.reachable ? '{}' : undefined;
      },
    }
  ) as {
    check: (
      ctx: typeof context,
      timeoutMs?: number
    ) => Promise<BundlePreparationResult>;
    schedule: (ctx: typeof context, rollback: string) => void;
  };
  return {
    values,
    state,
    timers,
    check: (timeoutMs?: number) => runtime.check(context, timeoutMs),
    initialize: () => runtime.schedule(context, 'rolled-back-version'),
  };
}

describe('native host API orchestration', () => {
  test('the config gate stand-in matches the shared core vectors', () => {
    for (const vector of vectorsFile.runnable) {
      expect({
        name: vector.name,
        verdict: JSON.parse(
          harmonyConfigBindings.runnableConfig(vector.config)
        ),
      }).toEqual({ name: vector.name, verdict: vector.expected });
    }
  });

  test('requires real launch initialization, without resolving the bundle', async () => {
    const h = harness();
    expect((await h.check()).reason).toBe('not_initialized');
    expect(h.state.checks).toBe(0);
    h.initialize();
    expect((await h.check()).status).toBe('noUpdate');
  });

  test('missing, disabled and malformed config do not consume a host round', async () => {
    const h = harness();
    h.initialize();
    h.values.delete('nativeConfig');
    expect((await h.check()).reason).toBe('not_configured');
    h.values.set('nativeConfig', '{');
    expect((await h.check()).reason).toBe('invalid_config');
    h.values.set('nativeConfig', JSON.stringify({ disabled: true }));
    expect((await h.check()).reason).toBe('disabled');
    expect(h.state.checks).toBe(0);
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'test-app' }));
    expect((await h.check()).status).toBe('noUpdate');
    expect(h.state.checks).toBe(1);
  });

  test('manual, concurrent and delayed calls share one download and commit', async () => {
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2', activate: true };
    const first = h.check();
    const second = h.check();
    for (const timer of h.timers) timer();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(
      bundlePreparationResult('downloaded', '', 'v2', true)
    );
    expect(results[1]).toEqual(results[0]);
    results[0].hash = 'caller-mutated';
    expect((await h.check()).hash).toBe('v2');
    expect(h.state.checks).toBe(1);
    expect(h.state.downloads).toBe(1);
    expect(h.state.commits).toBe(1);
    expect(h.values.has('nativeCheckIncomplete')).toBe(false);
  });

  test('a download need not select a bundle for the next launch', async () => {
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2', activate: false };
    expect(await h.check()).toEqual(
      bundlePreparationResult('downloaded', '', 'v2')
    );
  });

  test('an installed version skips transfer but still reports activation', async () => {
    const h = harness();
    h.initialize();
    h.state.installed = true;
    h.state.decision = { action: 'download', hash: 'v2', activate: true };
    expect((await h.check()).activated).toBe(true);
    expect(h.state.downloads).toBe(0);
  });

  test('network and download failure are not reported as no update', async () => {
    const offline = harness();
    offline.initialize();
    offline.state.reachable = false;
    expect(await offline.check()).toEqual(
      bundlePreparationResult('failed', 'check_failed')
    );
    const h = harness();
    h.initialize();
    h.state.decision = { action: 'download', hash: 'v2' };
    h.state.downloadOK = false;
    expect(await h.check()).toEqual(
      bundlePreparationResult('failed', 'download_failed')
    );
    await h.check();
    expect(h.state.downloads).toBe(1);
  });

  test('reset during a round cancels its result', async () => {
    const h = harness();
    h.initialize();
    h.state.beforeResponse = async () => {
      h.state.generation += 1;
    };
    expect(await h.check()).toEqual(
      bundlePreparationResult('cancelled', 'reset')
    );
  });

  test('a host timeout returns failed/timeout while the round carries on', async () => {
    const h = harness();
    h.initialize();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.state.beforeResponse = () => held;
    const armedBefore = h.timers.length;
    const waiting = h.check(5000);
    // The host's timer is the first one this call arms (the round arms its
    // own after it); fire it while the response is still held.
    await Promise.resolve();
    h.timers[armedBefore]();
    expect(await waiting).toEqual(bundlePreparationResult('failed', 'timeout'));

    // The round was not cut short: once the response arrives it completes,
    // and a later call gets its result.
    release();
    expect((await h.check()).status).toBe('noUpdate');
    expect(h.state.checks).toBe(1);
  });

  test('reset and configuration changes invalidate completed snapshots', async () => {
    const reset = harness();
    reset.initialize();
    await reset.check();
    reset.state.generation += 1;
    expect((await reset.check()).reason).toBe('reset');
    const h = harness();
    h.initialize();
    await h.check();
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'other-app' }));
    expect((await h.check()).reason).toBe('config_changed');
    expect(h.state.checks).toBe(1);
  });
});

test('automatic preflight without configuration leaves a round for later native provisioning', async () => {
  const h = harness();
  h.values.delete('nativeConfig');
  h.initialize();
  for (const timer of h.timers) timer();
  await Promise.resolve();
  expect(h.state.checks).toBe(0);
  h.values.set(
    'nativeConfig',
    JSON.stringify({
      appKey: 'native-first-app',
      afterDownload: 'setNeedUpdate',
    })
  );
  h.state.decision = { action: 'download', hash: 'v2', activate: true };
  expect((await h.check()).activated).toBe(true);
  expect(h.state.checks).toBe(1);
});

test('configuration replacement during an update cancels its returned snapshot', async () => {
  const h = harness();
  h.initialize();
  h.state.decision = { action: 'download', hash: 'v2', activate: true };
  h.state.beforeResponse = async () => {
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'replacement' }));
    h.state.generation += 1;
  };
  expect(await h.check()).toEqual(
    bundlePreparationResult('cancelled', 'config_changed')
  );
});
