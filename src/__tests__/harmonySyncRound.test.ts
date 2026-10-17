import { describe, expect, test } from 'bun:test';
import vectorsFile from '../../cpp/update_flow_core/tests/round-engine-vectors.json';
import {
  BundlePreparationRound,
  bundlePreparationResult,
} from '../../harmony/pushy/src/main/ets/BundlePreparationResult';
import {
  createPushyError,
  PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { evalHarmonyModule, harmonyStoreSchema } from './nativeSources';

// The Harmony adapter of the shared round engine (SyncCoordinator.runOnce),
// evaluated from source against the rounds in
// cpp/update_flow_core/tests/round-engine-vectors.json: the vector's commands
// stand in for the engine, and the IO those commands ask for is faked from
// the vector's next event. The adapter must answer each command with the
// event the vector expects, and map the finish to its result.

type Json = Record<string, unknown>;
interface Step {
  event: Json;
  commands: Json[];
}
interface Round {
  name: string;
  steps: Step[];
}

const fixtures = vectorsFile.fixtures as Record<string, unknown>;
const withFixtures = (value: unknown): unknown => {
  if (typeof value === 'string' && value.startsWith('@')) {
    return fixtures[value.slice(1)];
  }
  if (Array.isArray(value)) {
    return value.map(withFixtures);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withFixtures(entry)])
    );
  }
  return value;
};

// What an adapter decides by itself; the rest of each event is the engine's
// bookkeeping (the clock, the response time).
const ANSWER_FIELDS = [
  'type',
  'text',
  'installed',
  'ok',
  'code',
  'reason',
  'error',
  'activated',
];
const answer = (event: Json) =>
  Object.fromEntries(
    ANSWER_FIELDS.filter((key) => event[key] !== undefined).map((key) => [
      key,
      event[key],
    ])
  );

// Rounds whose events carry what Harmony never produces (a crash hold, a
// launch that waits on the round, a round deadline, a timed-out download, an
// activation the commit dropped) or that feed the engine protocol errors on
// purpose.
const replayable = (round: Round) =>
  round.steps[0].event.type === 'start' &&
  round.steps.every(
    ({ event }, i) =>
      (i === 0 || event.type !== 'start') &&
      !event.crashHold &&
      !event.forceActivate &&
      !event.timedOut &&
      !event.deadline &&
      event.activated === undefined
  ) &&
  !round.name.includes('internal_error');

async function replay(round: Round) {
  const steps = round.steps.map((step) => withFixtures(step) as Step);
  const start = steps[0].event;
  const sent: Json[] = [];
  let next = 0;
  // The event that answers the command being run: the vector's next one.
  const expected = () => steps[next]?.event ?? {};
  const download = async () => {
    const event = expected();
    if (event.ok !== true) {
      throw event.code === undefined
        ? new Error('socket closed')
        : createPushyError(String(event.code), 'fake');
    }
  };
  const values = new Map<string, string>([
    ['nativeConfig', String(start.config)],
    ['uuid', 'u-1'],
  ]);
  const context = {
    getKv: (key: string) => values.get(key),
    setKv: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeKv: async (key: string) => {
      values.delete(key);
    },
    getResetGeneration: () => start.resetGeneration,
    // A commit lost to a config change: the config generation moved.
    getNativeConfigGeneration: () =>
      expected().reason === 'config_changed'
        ? Number(start.configGeneration) + 1
        : start.configGeneration,
    getCurrentVersion: () => 'cur',
    getPackageVersion: () => '1.0.0',
    getBuildTime: () => '1700000000',
    getBundleHash: async () => 'bh',
    hasDownloadedVersion: () => expected().installed === true,
    downloadPatchFromPpk: download,
    downloadPatchFromPackage: download,
    downloadFullUpdate: download,
    commitSyncResult: async () => {
      const event = expected();
      if (event.error) {
        throw new Error('commit failed');
      }
      return event.ok === true;
    },
  };
  const runtime = evalHarmonyModule(
    'SyncCoordinator.ts',
    'httpRequest = fakeHttp;\n({ run: runOnce, result: () => roundResult });',
    {
      ...harmonyStoreSchema(),
      BundlePreparationRound,
      bundlePreparationResult,
      PushyError,
      logger: { info() {}, warn() {}, error() {} },
      deviceInfo: { osFullName: 'test-os' },
      getErrorMessage: (error: unknown) => String(error),
      monotonicNowMs: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
      fakeHttp: async () => expected().text as string | undefined,
      NativePatchCore: {
        stepRound: (_state: string | undefined, eventJson: string) => {
          sent.push(JSON.parse(eventJson));
          const step = steps[next++];
          return JSON.stringify({ state: {}, commands: step.commands });
        },
      },
    }
  ) as {
    run: (context: unknown, rollback: string) => Promise<void>;
    result: () => unknown;
  };
  await runtime.run(context, '');
  return { sent, steps, result: runtime.result(), values };
}

const rounds = (vectorsFile.rounds as Round[]).filter(replayable);

describe('harmony round adapter', () => {
  test('replays most of the engine vectors', () => {
    expect(rounds.length).toBeGreaterThanOrEqual(20);
  });

  for (const round of rounds) {
    test(round.name, async () => {
      const { sent, steps, result, values } = await replay(round);
      expect(sent.map(answer)).toEqual(steps.map(({ event }) => answer(event)));
      // The start carries the round's facts as the adapter sampled them.
      expect(sent[0]).toMatchObject({
        type: 'start',
        config: steps[0].event.config,
        resetGeneration: steps[0].event.resetGeneration,
        configGeneration: steps[0].event.configGeneration,
      });
      const finish = steps[steps.length - 1].commands.find(
        (command) => command.type === 'finish'
      ) as Json;
      expect(result).toEqual(
        finish.status === 'downloaded'
          ? bundlePreparationResult(
              'downloaded',
              '',
              String(finish.hash),
              finish.activated === true
            )
          : bundlePreparationResult(
              String(finish.status),
              String(finish.reason)
            )
      );
      // However the round ends, the breadcrumb does not survive it.
      expect(values.has('nativeCheckIncomplete')).toBe(false);
    });
  }
});
