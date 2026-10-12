import { describe, expect, test } from 'bun:test';
import { DownloadTaskParams } from '../../harmony/pushy/src/main/ets/DownloadTaskParams';
import { BUNDLE_DELTA_ENTRY } from '../../harmony/pushy/src/main/ets/Texts';
import { evalHarmonyModule } from './nativeSources';

// The pure parsers of Harmony DownloadTask.ts, evaluated from source with its
// platform imports stripped (the download/patch class itself needs a device).
// InstallRecord.ts imports @ohos modules, so its bundle name is inlined.
const HARMONY_BUNDLE_FILE_NAME = 'bundle.harmony.js';
interface PatchManifestArrays {
  copyFroms: string[];
  copyTos: string[];
  copyCrcs: (number | null)[];
  deletes: string[];
  hbcTransformMeta: string;
}

const { parseContentRangeTotal, parseManifestToArrays } = evalHarmonyModule(
  'DownloadTask.ts',
  '({ parseContentRangeTotal, parseManifestToArrays });',
  { HARMONY_BUNDLE_FILE_NAME, BUNDLE_DELTA_ENTRY }
) as {
  parseContentRangeTotal(header: string, expectedStart: number): number;
  parseManifestToArrays(
    manifest: Record<string, unknown>,
    normalizeResourceCopies: boolean
  ): PatchManifestArrays;
};

// A 206's Content-Range decides whether appended bytes can be trusted.
describe('harmony parseContentRangeTotal', () => {
  test('returns the total for a well-formed range at the expected start', () => {
    expect(parseContentRangeTotal('bytes 100-199/200', 100)).toBe(200);
    expect(parseContentRangeTotal('bytes 0-9/10', 0)).toBe(10);
    expect(parseContentRangeTotal('bytes 100-100/200', 100)).toBe(200);
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseContentRangeTotal('bytes  100-199 / 200 ', 100)).toBe(200);
  });

  test('returns 0 for an unknown total (*)', () => {
    expect(parseContentRangeTotal('bytes 100-199/*', 100)).toBe(0);
  });

  test('rejects a start that does not match the local partial', () => {
    expect(parseContentRangeTotal('bytes 50-199/200', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 0-199/200', 100)).toBe(-1);
  });

  test('rejects missing or foreign units', () => {
    expect(parseContentRangeTotal('', 0)).toBe(-1);
    expect(parseContentRangeTotal('100-199/200', 100)).toBe(-1);
    expect(parseContentRangeTotal('items 100-199/200', 100)).toBe(-1);
  });

  test('rejects malformed ranges', () => {
    expect(parseContentRangeTotal('bytes 100-199', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100/200', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes */200', 0)).toBe(-1);
    expect(parseContentRangeTotal('bytes abc-199/200', 100)).toBe(-1);
  });

  test('rejects non-positive or non-numeric totals', () => {
    expect(parseContentRangeTotal('bytes 100-199/0', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-199/-5', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-199/abc', 100)).toBe(-1);
  });

  // A numeric total must exceed end (RFC 9110 §14.4); end cannot precede start.
  test('rejects a range that contradicts its total', () => {
    expect(parseContentRangeTotal('bytes 100-199/199', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-199/150', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-99/200', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-99/*', 100)).toBe(-1);
    expect(parseContentRangeTotal('bytes 100-x/200', 100)).toBe(-1);
  });
});

describe('harmony parseManifestToArrays', () => {
  test('returns empty arrays for an empty manifest', () => {
    // toEqual across the VM boundary compares plain values.
    expect(
      JSON.parse(JSON.stringify(parseManifestToArrays({}, false)))
    ).toEqual({
      copyFroms: [],
      copyTos: [],
      copyCrcs: [],
      deletes: [],
      hbcTransformMeta: '',
    });
  });

  test('parses copies and a deletes array', () => {
    const result = parseManifestToArrays(
      {
        copies: {
          'assets/icon.png': 'assets/original.png',
          'assets/logo.png': 'assets/brand.png',
        },
        deletes: ['assets/old.png', 'assets/removed.txt'],
      },
      false
    );
    expect([...result.copyFroms]).toEqual([
      'assets/original.png',
      'assets/brand.png',
    ]);
    expect([...result.copyTos]).toEqual(['assets/icon.png', 'assets/logo.png']);
    expect([...result.deletes]).toEqual([
      'assets/old.png',
      'assets/removed.txt',
    ]);
  });

  test('parses deletes given as object keys', () => {
    const result = parseManifestToArrays(
      { deletes: { 'assets/old.png': true, 'assets/removed.txt': true } },
      false
    );
    expect([...result.deletes]).toEqual([
      'assets/old.png',
      'assets/removed.txt',
    ]);
  });

  test('handles missing copies or deletes', () => {
    const noCopies = parseManifestToArrays({ deletes: ['a.txt'] }, false);
    expect(noCopies.copyFroms.length).toBe(0);
    expect(noCopies.deletes.length).toBe(1);
    const noDeletes = parseManifestToArrays(
      { copies: { 'a.png': 'b.png' } },
      false
    );
    expect(noDeletes.deletes.length).toBe(0);
    expect(noDeletes.copyFroms.length).toBe(1);
  });

  test('normalizes rawfile resource copies only when enabled', () => {
    const manifest = {
      copies: { 'assets/icon.png': 'resources/rawfile/assets/icon.png' },
    };
    expect(parseManifestToArrays(manifest, true).copyFroms[0]).toBe(
      'assets/icon.png'
    );
    expect(parseManifestToArrays(manifest, false).copyFroms[0]).toBe(
      'resources/rawfile/assets/icon.png'
    );
  });

  test('falls back to the key when the normalized source is empty', () => {
    const result = parseManifestToArrays(
      { copies: { 'assets/icon.png': 'resources/rawfile/' } },
      true
    );
    expect(result.copyFroms[0]).toBe('assets/icon.png');
  });

  test('treats a null source as empty', () => {
    const result = parseManifestToArrays(
      { copies: { 'assets/icon.png': null } },
      false
    );
    expect(result.copyFroms[0]).toBe('');
    expect(result.copyTos[0]).toBe('assets/icon.png');
  });

  test('aligns copiesCrc with the copies and keeps only finite numbers', () => {
    const result = parseManifestToArrays(
      {
        copies: { a: 'x', b: 'y', c: 'z' },
        copiesCrc: { a: 123, c: 'nope' },
      },
      false
    );
    expect([...result.copyCrcs]).toEqual([123, null, null]);
  });

  test('extracts the bundle entry hbcTransform metadata', () => {
    const meta = { version: 1, base: 'abc' };
    const result = parseManifestToArrays(
      { hbcTransform: { [BUNDLE_DELTA_ENTRY]: meta, other: { x: 1 } } },
      false
    );
    expect(JSON.parse(result.hbcTransformMeta)).toEqual(meta);
    expect(
      parseManifestToArrays({ hbcTransform: { other: {} } }, false)
        .hbcTransformMeta
    ).toBe('');
  });
});

describe('harmony DownloadTaskParams', () => {
  test('defaults to a full-package task with empty paths', () => {
    const params = new DownloadTaskParams();
    expect(params.type).toBe(DownloadTaskParams.TASK_TYPE_PATCH_FULL);
    expect(params.url).toBe('');
    expect(params.hash).toBe('');
    expect(params.originHash).toBe('');
    expect(params.targetFile).toBe('');
    expect(params.unzipDirectory).toBe('');
    expect(params.originDirectory).toBe('');
    expect(params.deadlineUptimeMs).toBe(0);
  });

  test('task types are distinct', () => {
    expect(
      new Set([
        DownloadTaskParams.TASK_TYPE_PATCH_FULL,
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP,
        DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK,
      ]).size
    ).toBe(3);
  });
});
