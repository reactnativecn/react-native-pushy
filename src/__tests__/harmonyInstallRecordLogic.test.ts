import { describe, expect, test } from 'bun:test';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_SWITCH_VERSION_FAILED,
  type PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { evalHarmonyModule } from './nativeSources';

// The pure record logic of Harmony InstallRecord.ts (ArkTS mirror of
// cpp/patch_core/install_record.h): parsing, version matching and the
// activation digest rule. The disk-backed activation path is covered by
// harmonyInstallRecord.test.ts.
interface InstallRecordData {
  schema?: number;
  versionHash?: string;
  bundleSha256?: unknown;
  artifactSha256?: string;
}

interface InstallRecordLogic {
  INSTALL_RECORD_SCHEMA: number;
  INSTALL_RECORD_FILE_NAME: string;
  STAGING_SUFFIX: string;
  buildInstallRecord(hash: string, bundle: string, artifact: string): string;
  parseInstallRecord(text: string): InstallRecordData | null;
  isRecordForVersion(record: InstallRecordData | null, hash: string): boolean;
  expectedBundleSha256ForActivation(
    record: InstallRecordData | null,
    hash: string
  ): string;
  stagingDirectoryFor(versionDir: string): string;
  isReservedEntryName(name: string): boolean;
}

const record = evalHarmonyModule(
  'InstallRecord.ts',
  `({ INSTALL_RECORD_SCHEMA, INSTALL_RECORD_FILE_NAME, STAGING_SUFFIX,
   buildInstallRecord, parseInstallRecord, isRecordForVersion,
   expectedBundleSha256ForActivation, stagingDirectoryFor,
   isReservedEntryName });`,
  { ERROR_DELTA_FAILED, ERROR_SWITCH_VERSION_FAILED, createPushyError }
) as InstallRecordLogic;

function thrown(fn: () => unknown): PushyError {
  try {
    fn();
  } catch (e) {
    return e as PushyError;
  }
  throw new Error('expected a throw');
}

describe('harmony install record writer', () => {
  test('serializes schema, version and digests', () => {
    const parsed = record.parseInstallRecord(
      record.buildInstallRecord('abc', 'BUNDLE', 'ARTIFACT')
    );
    expect({ ...parsed }).toEqual({
      schema: record.INSTALL_RECORD_SCHEMA,
      versionHash: 'abc',
      bundleSha256: 'BUNDLE',
      artifactSha256: 'ARTIFACT',
    });
  });

  test('omits an empty artifact digest', () => {
    const parsed = record.parseInstallRecord(
      record.buildInstallRecord('abc', 'BUNDLE', '')
    );
    expect(parsed?.artifactSha256).toBeUndefined();
  });

  test('refuses a record without a bundle digest', () => {
    expect(thrown(() => record.buildInstallRecord('abc', '', 'A')).code).toBe(
      ERROR_DELTA_FAILED
    );
  });

  test('derives the staging directory from the version directory', () => {
    expect(record.stagingDirectoryFor('/data/_update/abc')).toBe(
      `/data/_update/abc${record.STAGING_SUFFIX}`
    );
  });
});

describe('harmony install record parsing', () => {
  test('an empty file is a legacy record', () => {
    expect(Object.keys(record.parseInstallRecord('') ?? { x: 1 })).toEqual([]);
  });

  test('parses a JSON object', () => {
    expect({
      ...record.parseInstallRecord('{"schema":1,"versionHash":"abc"}'),
    }).toEqual({ schema: 1, versionHash: 'abc' });
  });

  test('rejects malformed or non-object content', () => {
    for (const text of ['{oops', '[1,2]', '"text"', 'null']) {
      expect(record.parseInstallRecord(text)).toBeNull();
    }
  });
});

describe('harmony install record matching', () => {
  test('presence: no record, legacy record, schema and version', () => {
    expect(record.isRecordForVersion(null, 'abc')).toBe(false);
    expect(record.isRecordForVersion({}, 'abc')).toBe(true);
    const current = record.parseInstallRecord(
      record.buildInstallRecord('abc', 'DIGEST', '')
    );
    expect(record.isRecordForVersion(current, 'abc')).toBe(true);
    expect(record.isRecordForVersion(current, 'def')).toBe(false);
    expect(
      record.isRecordForVersion(
        { schema: record.INSTALL_RECORD_SCHEMA + 1, versionHash: 'abc' },
        'abc'
      )
    ).toBe(false);
  });

  test('activation: no record is SWITCH_VERSION_FAILED with a code prefix', () => {
    const error = thrown(() =>
      record.expectedBundleSha256ForActivation(null, 'abc')
    );
    expect(error.code).toBe(ERROR_SWITCH_VERSION_FAILED);
    expect(error.message.startsWith(`[${ERROR_SWITCH_VERSION_FAILED}] `)).toBe(
      true
    );
    expect(error.message).toContain('no valid completion record');
  });

  test('activation: a legacy record has nothing to verify', () => {
    expect(record.expectedBundleSha256ForActivation({}, 'abc')).toBe('');
  });

  test('activation: returns the recorded digest of a matching record', () => {
    expect(
      record.expectedBundleSha256ForActivation(
        record.parseInstallRecord(record.buildInstallRecord('abc', 'D', '')),
        'abc'
      )
    ).toBe('D');
  });

  test('activation: rejects digest-less, foreign and future records', () => {
    const schema = record.INSTALL_RECORD_SCHEMA;
    const records: InstallRecordData[] = [
      { schema, versionHash: 'abc' },
      { schema, versionHash: 'abc', bundleSha256: '' },
      { schema, versionHash: 'abc', bundleSha256: 7 },
      { schema, versionHash: 'abc', artifactSha256: 'A' },
      { schema, versionHash: 'def', bundleSha256: 'D' },
      { schema: schema + 1, versionHash: 'abc', bundleSha256: 'D' },
    ];
    for (const candidate of records) {
      const error = thrown(() =>
        record.expectedBundleSha256ForActivation(candidate, 'abc')
      );
      expect(error.code).toBe(ERROR_SWITCH_VERSION_FAILED);
      expect(error.message).toContain('record mismatch');
    }
  });
});

describe('harmony reserved archive entries', () => {
  test('every .pushy- prefixed name is reserved', () => {
    expect(record.isReservedEntryName(record.INSTALL_RECORD_FILE_NAME)).toBe(
      true
    );
    expect(record.isReservedEntryName('.pushy-anything')).toBe(true);
  });

  test('ordinary entries are allowed', () => {
    for (const name of ['bundle.harmony.js', '.pushyx', 'pushy-complete']) {
      expect(record.isReservedEntryName(name)).toBe(false);
    }
  });
});
