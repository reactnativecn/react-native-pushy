import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

// Harmony InstallRecord.ts (ArkTS mirror of cpp/patch_core/install_record.h)
// imports @ohos modules, so it is evaluated with its imports stripped and its
// collaborators (file system, native digest, error factory) supplied as
// in-memory stubs. The on-device hypium suite (InstallRecord.test.ets) only
// runs in harmony CI; this keeps the record contract under `bun run test`.

class PushyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

interface InstallRecordModule {
  buildInstallRecord(
    versionHash: string,
    bundleSha256: string,
    artifactSha256: string
  ): string;
  expectedBundleSha256ForActivation(
    record: Record<string, unknown> | null,
    versionHash: string
  ): string;
  verifyInstallForActivation(
    versionDir: string,
    versionHash: string,
    bundlePath: string
  ): Promise<void>;
}

function loadInstallRecord(
  files: Map<string, string>,
  digests: Map<string, string>
): InstallRecordModule {
  const source = readFileSync(
    new URL(
      '../../harmony/pushy/src/main/ets/InstallRecord.ts',
      import.meta.url
    ),
    'utf8'
  )
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const fileIo = {
    accessSync: (path: string) => files.has(path),
    statSync: (path: string) => ({ size: files.get(path)?.length ?? 0 }),
    readTextSync: (path: string) => files.get(path) ?? '',
  };
  const NativePatchCore = {
    sha256HexFileAsync: async (path: string) => {
      const digest = digests.get(path);
      if (digest === undefined) {
        throw new Error('sha256HexFileAsync: cannot read file');
      }
      return digest;
    },
  };
  return runInNewContext(
    `${js}\n({ buildInstallRecord, expectedBundleSha256ForActivation, verifyInstallForActivation });`,
    {
      fileIo,
      NativePatchCore,
      ERROR_DELTA_FAILED: 'PATCH_FAILED',
      ERROR_SWITCH_VERSION_FAILED: 'SWITCH_VERSION_FAILED',
      createPushyError: (code: string, message: string) =>
        new PushyError(code, message),
      util: {},
    }
  );
}

const HASH = 'abc';
const DIR = `/data/_update/${HASH}`;
const RECORD = `${DIR}/.pushy-complete`;
const BUNDLE = `${DIR}/bundle.harmony.js`;
const DIGEST = 'ab'.repeat(32);

function captureError(fn: () => unknown): PushyError {
  try {
    fn();
  } catch (e) {
    return e as PushyError;
  }
  throw new Error('expected a throw');
}

describe('harmony install record writer', () => {
  const { buildInstallRecord } = loadInstallRecord(new Map(), new Map());

  test('writes the mandatory bundle digest', () => {
    expect(JSON.parse(buildInstallRecord(HASH, DIGEST, 'ff'))).toEqual({
      schema: 1,
      versionHash: HASH,
      bundleSha256: DIGEST,
      artifactSha256: 'ff',
    });
    expect(JSON.parse(buildInstallRecord(HASH, DIGEST, ''))).toEqual({
      schema: 1,
      versionHash: HASH,
      bundleSha256: DIGEST,
    });
  });

  test('refuses a record without a bundle digest (install fails)', () => {
    const error = captureError(() => buildInstallRecord(HASH, '', 'ff'));
    expect(error.code).toBe('PATCH_FAILED');
    expect(error.message).toContain('no bundle digest');
  });
});

describe('harmony install record activation', () => {
  test('a legacy empty record stays trusted without hashing', async () => {
    const files = new Map([[RECORD, '']]);
    const { verifyInstallForActivation } = loadInstallRecord(files, new Map());
    await verifyInstallForActivation(DIR, HASH, BUNDLE);
  });

  test('a matching digest activates, case-insensitively', async () => {
    const files = new Map([
      [
        RECORD,
        JSON.stringify({
          schema: 1,
          versionHash: HASH,
          bundleSha256: DIGEST.toUpperCase(),
        }),
      ],
    ]);
    const { verifyInstallForActivation } = loadInstallRecord(
      files,
      new Map([[BUNDLE, DIGEST]])
    );
    await verifyInstallForActivation(DIR, HASH, BUNDLE);
  });

  test('a tampered bundle is rejected', async () => {
    const files = new Map([
      [
        RECORD,
        JSON.stringify({ schema: 1, versionHash: HASH, bundleSha256: DIGEST }),
      ],
    ]);
    const { verifyInstallForActivation } = loadInstallRecord(
      files,
      new Map([[BUNDLE, 'cd'.repeat(32)]])
    );
    await expect(verifyInstallForActivation(DIR, HASH, BUNDLE)).rejects.toThrow(
      'bundle digest mismatch'
    );
  });

  for (const [name, record] of [
    ['no', { schema: 1, versionHash: HASH }],
    ['an empty', { schema: 1, versionHash: HASH, bundleSha256: '' }],
    ['a null', { schema: 1, versionHash: HASH, bundleSha256: null }],
    ['a non-string', { schema: 1, versionHash: HASH, bundleSha256: 123 }],
    [
      'only an artifact',
      { schema: 1, versionHash: HASH, artifactSha256: DIGEST },
    ],
  ] as const) {
    test(`a schema 1 record with ${name} bundle digest is rejected`, async () => {
      const files = new Map([[RECORD, JSON.stringify(record)]]);
      // The bundle hashes fine: rejection must come from the record alone.
      const { verifyInstallForActivation, expectedBundleSha256ForActivation } =
        loadInstallRecord(files, new Map([[BUNDLE, DIGEST]]));
      const error = captureError(() =>
        expectedBundleSha256ForActivation(record, HASH)
      );
      expect(error.code).toBe('SWITCH_VERSION_FAILED');
      expect(error.message).toContain('completion record mismatch');
      await expect(
        verifyInstallForActivation(DIR, HASH, BUNDLE)
      ).rejects.toThrow('completion record mismatch');
    });
  }

  test('a missing or foreign record is rejected', async () => {
    const { verifyInstallForActivation } = loadInstallRecord(
      new Map(),
      new Map()
    );
    await expect(verifyInstallForActivation(DIR, HASH, BUNDLE)).rejects.toThrow(
      'no valid completion record'
    );
    const foreign = new Map([
      [
        RECORD,
        JSON.stringify({ schema: 1, versionHash: 'def', bundleSha256: DIGEST }),
      ],
    ]);
    await expect(
      loadInstallRecord(foreign, new Map()).verifyInstallForActivation(
        DIR,
        HASH,
        BUNDLE
      )
    ).rejects.toThrow('completion record mismatch');
  });
});
