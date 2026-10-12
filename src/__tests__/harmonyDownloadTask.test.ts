import { describe, expect, test } from 'bun:test';
import { DownloadTaskParams } from '../../harmony/pushy/src/main/ets/DownloadTaskParams';
import { BUNDLE_DELTA_ENTRY } from '../../harmony/pushy/src/main/ets/Texts';
import { evalHarmonyModule } from './nativeSources';

// The pure parsers of Harmony DownloadTask.ts, evaluated from source with its
// platform imports stripped (the download/patch class itself needs a device).
// InstallRecord.ts imports @ohos modules, so its bundle name is inlined.
// __diff.json is parsed by the native core only
// (cpp/patch_core/tests/patch-manifest-vectors.json).
const HARMONY_BUNDLE_FILE_NAME = 'bundle.harmony.js';

const { parseContentRangeTotal } = evalHarmonyModule(
  'DownloadTask.ts',
  '({ parseContentRangeTotal });',
  { HARMONY_BUNDLE_FILE_NAME, BUNDLE_DELTA_ENTRY }
) as {
  parseContentRangeTotal(header: string, expectedStart: number): number;
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
