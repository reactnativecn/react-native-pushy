import { describe, expect, test } from 'bun:test';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_FILE_OPERATION_FAILED,
  getErrorMessage,
  type PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { evalHarmonyModule, source } from './nativeSources';

// Harmony ArchiveLimits.ts is a thin binding over the shared extraction
// accounting (cpp/patch_core/archive_limits.h, replayed against
// tests/archive-limits-vectors.json by the C++ test). What is left to test
// here: the getOriginalSize gate (Harmony only), what it hands the NAPI
// module, and the stable error code it maps refusals to.
interface ArchiveLimits {
  ORIGINAL_SIZE_UNAVAILABLE: string;
  checkOriginalSize(size: number | undefined, failure?: string): number;
  checkUncompressedSize(archiveBytes: number, uncompressedBytes: number): void;
  checkExtractedDirectory(
    directory: string,
    archiveBytes: number
  ): Promise<void>;
}

function load(refusal?: string) {
  const calls: Array<[string, unknown[]]> = [];
  const NativePatchCore = {
    checkUncompressedSize: (...args: unknown[]) => {
      calls.push(['checkUncompressedSize', args]);
      return refusal;
    },
    checkExtractedDirectory: async (...args: unknown[]) => {
      calls.push(['checkExtractedDirectory', args]);
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
    },
  };
  const limits = evalHarmonyModule(
    'ArchiveLimits.ts',
    `({ ORIGINAL_SIZE_UNAVAILABLE, checkOriginalSize, checkUncompressedSize,
       checkExtractedDirectory });`,
    {
      NativePatchCore,
      ERROR_DELTA_FAILED,
      ERROR_FILE_OPERATION_FAILED,
      createPushyError,
      getErrorMessage,
    }
  ) as ArchiveLimits;
  return { limits, calls };
}

function refusal(run: () => unknown): PushyError | null {
  try {
    run();
  } catch (e) {
    return e as PushyError;
  }
  return null;
}

// getOriginalSize unavailable: refuse (never pass through), with its own detail.
describe('harmony checkOriginalSize', () => {
  const { limits } = load();

  test('passes a finite non-negative size through', () => {
    expect(limits.checkOriginalSize(0)).toBe(0);
    expect(limits.checkOriginalSize(12345)).toBe(12345);
  });

  test('refuses when getOriginalSize threw, with its own detail', () => {
    const error = refusal(() => limits.checkOriginalSize(undefined, 'boom'));
    expect(error?.code).toBe(ERROR_DELTA_FAILED);
    expect(error?.message).toContain(limits.ORIGINAL_SIZE_UNAVAILABLE);
    expect(error?.message).toContain('getOriginalSize failed: boom');
  });

  test('refuses an unusable result, distinct from the thrown case', () => {
    for (const size of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const error = refusal(() => limits.checkOriginalSize(size));
      expect(error?.code).toBe(ERROR_DELTA_FAILED);
      expect(error?.message).toContain(limits.ORIGINAL_SIZE_UNAVAILABLE);
      expect(error?.message).toContain('getOriginalSize returned');
    }
  });
});

describe('harmony archive limit bindings', () => {
  test('hand the sizes and the directory to the core', async () => {
    const { limits, calls } = load();
    expect(refusal(() => limits.checkUncompressedSize(1024, 4096))).toBeNull();
    await limits.checkExtractedDirectory('/data/_update/abc.staging', 1024);
    expect(calls).toEqual([
      ['checkUncompressedSize', [1024, 4096]],
      ['checkExtractedDirectory', ['/data/_update/abc.staging', 1024]],
    ]);
  });

  test('a refusal is PATCH_FAILED with the core message', async () => {
    const reason = 'archive compression ratio exceeds 100:1 (2097152/20000)';
    const { limits } = load(reason);
    const sync = refusal(() => limits.checkUncompressedSize(20000, 2097152));
    expect(sync?.code).toBe(ERROR_DELTA_FAILED);
    expect(sync?.message).toBe(`[${ERROR_DELTA_FAILED}] ${reason}`);
    let walked: PushyError | null = null;
    try {
      await limits.checkExtractedDirectory('/data/_update/abc.staging', 20000);
    } catch (e) {
      walked = e as PushyError;
    }
    expect(walked?.code).toBe(ERROR_DELTA_FAILED);
    expect(walked?.message).toBe(`[${ERROR_DELTA_FAILED}] ${reason}`);
  });

  test('the download loop plans its disk probes in the core', () => {
    const task = source('harmony/pushy/src/main/ets/DownloadTask.ts');
    expect(task).toContain('NativePatchCore.planFreeSpaceProbe(');
    expect(task).toContain('await checkExtractedDirectory(');
  });
});
