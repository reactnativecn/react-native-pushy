import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

// The endpoint fallback of the Harmony cold-start orchestrator
// (SyncCoordinator.runQueryRequest), evaluated from source with its platform
// imports stripped and HTTP replaced by a scripted fake.
const source = readFileSync(
  new URL(
    '../../harmony/pushy/src/main/ets/SyncCoordinator.ts',
    import.meta.url
  ),
  'utf8'
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');
const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);

const VALID = '{"ok":true}';

interface Config {
  endpoints?: string[];
  queryUrls?: string[];
}

function run(
  config: Config,
  responses: Record<string, string | undefined>,
  httpsOnly = false
) {
  const requests: string[] = [];
  const runQueryRequest = runInNewContext(
    `${javascript}\nhttpRequest = fakeHttp;\nrunQueryRequest;`,
    {
      QUERY_PATH: '/q/',
      logger: { info() {}, warn() {}, error() {} },
      BundlePreparationRound: class {},
      bundlePreparationResult: () => ({}),
      NativePatchCore: {
        // Keep the configured order: ordering is the C++ core's concern.
        orderEndpointCandidates: (json: string) => json,
        isValidResponse: (text: string) => text === VALID,
      },
      fakeHttp: async (url: string) => {
        requests.push(url);
        return responses[url];
      },
    }
  ) as (
    config: Config,
    appKey: string,
    body: string,
    httpsOnly: boolean
  ) => Promise<string | undefined>;
  return runQueryRequest(config, 'key', '{}', httpsOnly).then((result) => ({
    result,
    requests,
  }));
}

describe('harmony query endpoint fallback', () => {
  test('falls back through configured endpoints, deduped by normalized base', async () => {
    const { result, requests } = await run(
      { endpoints: ['https://a/', 'https://a', '', 'https://b'] },
      { 'https://b/q/key': VALID }
    );
    expect(result).toBe(VALID);
    expect(requests).toEqual(['https://a/q/key', 'https://b/q/key']);
  });

  test('an invalid response does not stop the fallback', async () => {
    const { result } = await run(
      { endpoints: ['https://a', 'https://b'] },
      { 'https://a/q/key': '{"error":"x"}', 'https://b/q/key': VALID }
    );
    expect(result).toBe(VALID);
  });

  test('discovers remote endpoints, skipping tried, non-string and cleartext ones', async () => {
    const { result, requests } = await run(
      {
        endpoints: ['https://a'],
        queryUrls: ['', 'https://list'],
      },
      {
        'https://list': JSON.stringify([
          'https://a/',
          42,
          'http://plain',
          'https://c',
        ]),
        'https://c/q/key': VALID,
      },
      true
    );
    expect(result).toBe(VALID);
    expect(requests).toEqual([
      'https://a/q/key',
      'https://list',
      'https://c/q/key',
    ]);
  });

  test('cleartext remote endpoints are allowed without an https-only config', async () => {
    const { result } = await run(
      { endpoints: ['http://a'], queryUrls: ['https://list'] },
      {
        'https://list': JSON.stringify(['http://plain']),
        'http://plain/q/key': VALID,
      }
    );
    expect(result).toBe(VALID);
  });

  test('only the first parsable remote list is used', async () => {
    const { requests } = await run(
      { endpoints: [], queryUrls: ['https://bad', 'https://l1', 'https://l2'] },
      {
        'https://bad': '{"not":"array"}',
        'https://l1': JSON.stringify(['https://x']),
        'https://l2': JSON.stringify(['https://y']),
      }
    );
    expect(requests).toEqual(['https://bad', 'https://l1', 'https://x/q/key']);
  });

  test('stops after 8 HTTP requests, list fetches included', async () => {
    const endpoints = Array.from({ length: 6 }, (_, i) => `https://e${i}`);
    const { result, requests } = await run(
      { endpoints, queryUrls: ['https://list'] },
      {
        'https://list': JSON.stringify(['https://r0', 'https://r1', 'https://r2']),
        'https://r2/q/key': VALID,
      }
    );
    expect(result).toBeUndefined();
    expect(requests).toEqual([
      ...endpoints.map((e) => `${e}/q/key`),
      'https://list',
      'https://r0/q/key',
    ]);
  });
});
