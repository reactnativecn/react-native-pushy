import { describe, expect, test } from 'bun:test';
import { evalHarmonyModule } from './nativeSources';

// The endpoint walk of the Harmony cold-start orchestrator
// (SyncCoordinator.runQueryRequest), evaluated from source with its platform
// imports stripped and HTTP replaced by a scripted fake. The walk's policy —
// order, list discovery, https-only remote bases, the request budget,
// response validity — is the shared core's NextQueryStep, pinned by
// cpp/update_flow_core/tests/native-round-vectors.json; this checks that the
// glue follows the core's steps.

const VALID = '{"upToDate":true}';

interface Step {
  url?: string;
  post?: boolean;
  found?: boolean;
}

function run(
  steps: Array<Step | undefined>,
  responses: Record<string, string>
) {
  const requests: Array<[string, string | undefined]> = [];
  const calls: Array<[string, string | undefined]> = [];
  let next = 0;
  const runQueryRequest = evalHarmonyModule(
    'SyncCoordinator.ts',
    'httpRequest = fakeHttp;\nrunQueryRequest;',
    {
      logger: { info() {}, warn() {}, error() {} },
      BundlePreparationRound: class {},
      bundlePreparationResult: () => ({}),
      NativePatchCore: {
        nextQueryStep: (state: string, text: string | undefined) => {
          calls.push([state, text]);
          const step = steps[next++];
          return step === undefined
            ? undefined
            : JSON.stringify({ ...step, n: next });
        },
      },
      fakeHttp: async (url: string, body?: string) => {
        requests.push([url, body]);
        return responses[url];
      },
    }
  ) as (query: string, body: string) => Promise<string | undefined>;
  return runQueryRequest('{"n":0}', 'BODY').then((result) => ({
    result,
    requests,
    calls,
  }));
}

describe('harmony query endpoint walk', () => {
  test('issues each step, passes its text back and returns the found one', async () => {
    const { result, requests, calls } = await run(
      [
        { url: 'https://a/q', post: true },
        { url: 'https://l', post: false },
        { url: 'https://c/q', post: true },
        { found: true },
      ],
      { 'https://l': '["https://c"]', 'https://c/q': VALID }
    );
    expect(result).toBe(VALID);
    expect(requests).toEqual([
      ['https://a/q', 'BODY'],
      ['https://l', undefined],
      ['https://c/q', 'BODY'],
    ]);
    // Each call carries the previous state and the last request's text.
    expect(calls.map(([state]) => JSON.parse(state).n)).toEqual([0, 1, 2, 3]);
    expect(calls.map(([, text]) => text)).toEqual([
      undefined,
      undefined,
      '["https://c"]',
      VALID,
    ]);
  });

  test('a step without a url ends the walk with no response', async () => {
    const { result, requests } = await run(
      [{ url: 'https://a/q', post: true }, {}],
      { 'https://a/q': '{"error":"x"}' }
    );
    expect(result).toBeUndefined();
    expect(requests).toEqual([['https://a/q', 'BODY']]);
  });

  test('a state the core rejects ends the walk', async () => {
    const { result, requests } = await run([undefined], {});
    expect(result).toBeUndefined();
    expect(requests).toEqual([]);
  });
});
