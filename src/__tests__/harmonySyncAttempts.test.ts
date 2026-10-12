import { describe, expect, test } from 'bun:test';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_DOWNLOAD_FAILED,
  PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { evalHarmonyModule } from './nativeSources';

// The download strategy loop of the Harmony cold-start orchestrator
// (SyncCoordinator.performAttempts), evaluated from source with its platform
// imports stripped. A patch that downloaded but failed to apply is not
// retried on the other mirrors (update_flow_core IsMirrorRetryableCode).

interface Attempt {
  type: string;
  urls: string[];
}

// failures: url -> error code (a coded PushyError) or any thrown value.
function harness(failures: Map<string, unknown>) {
  const calls: string[] = [];
  const fail = async (url: string) => {
    calls.push(url);
    const failure = failures.get(url);
    if (typeof failure === 'string') {
      throw createPushyError(failure, `failed ${url}`);
    }
    if (failure !== undefined) {
      throw failure;
    }
  };
  const context = {
    downloadPatchFromPpk: (url: string) => fail(url),
    downloadPatchFromPackage: (url: string) => fail(url),
    downloadFullUpdate: (url: string) => fail(url),
  };
  const performAttempts = evalHarmonyModule(
    'SyncCoordinator.ts',
    'performAttempts;',
    {
      PushyError,
      ERROR_DELTA_FAILED,
      ERROR_DOWNLOAD_FAILED,
      createPushyError,
      getErrorMessage: (error: unknown) => String(error),
      logger: { info() {}, warn() {}, error() {} },
      monotonicNowMs: () => performance.now(),
      setTimeout,
      clearTimeout,
      BundlePreparationRound: class {},
      bundlePreparationResult: () => ({}),
    }
  ) as (
    ctx: typeof context,
    attempts: Attempt[],
    hash: string,
    originHash: string,
    httpsOnly: boolean
  ) => Promise<boolean>;
  return {
    calls,
    run: (attempts: Attempt[], originHash = 'origin') =>
      performAttempts(context, attempts, 'next', originHash, false),
  };
}

describe('harmony download attempts', () => {
  test('a patch that fails to apply skips the remaining mirrors', async () => {
    const h = harness(
      new Map([
        ['https://a/diff', ERROR_DELTA_FAILED],
        ['https://b/diff', ERROR_DELTA_FAILED],
      ])
    );
    const ok = await h.run([
      { type: 'diff', urls: ['https://a/diff', 'https://b/diff'] },
      { type: 'full', urls: ['https://a/full', 'https://b/full'] },
    ]);
    expect(ok).toBe(true);
    expect(h.calls).toEqual(['https://a/diff', 'https://a/full']);
  });

  test('a download failure still tries the next mirror', async () => {
    const h = harness(new Map([['https://a/pdiff', ERROR_DOWNLOAD_FAILED]]));
    const ok = await h.run([
      { type: 'pdiff', urls: ['https://a/pdiff', 'https://b/pdiff'] },
      { type: 'full', urls: ['https://a/full'] },
    ]);
    expect(ok).toBe(true);
    expect(h.calls).toEqual(['https://a/pdiff', 'https://b/pdiff']);
  });

  test('an uncoded error is retryable', async () => {
    const h = harness(
      new Map([['https://a/full', new Error('socket closed')]])
    );
    const ok = await h.run([
      { type: 'full', urls: ['https://a/full', 'https://b/full'] },
    ]);
    expect(ok).toBe(true);
    expect(h.calls).toEqual(['https://a/full', 'https://b/full']);
  });

  test('every strategy failing to apply reports failure', async () => {
    const h = harness(
      new Map([
        ['https://a/full', ERROR_DELTA_FAILED],
        ['https://b/full', ERROR_DELTA_FAILED],
      ])
    );
    expect(
      await h.run([
        { type: 'full', urls: ['https://a/full', 'https://b/full'] },
      ])
    ).toBe(false);
    expect(h.calls).toEqual(['https://a/full']);
  });
});
