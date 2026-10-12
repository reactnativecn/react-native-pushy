import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_FILE_OPERATION_FAILED,
  type PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';

// The pure limit logic of Harmony ArchiveLimits.ts (ArkTS mirror of
// cpp/patch_core/archive_limits.h), evaluated from source with its file
// system imports stripped.
interface FreeSpaceProbePlan {
  probe: boolean;
  reserve: number;
  reservedUntil: number;
}

interface ArchiveLimits {
  UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES: number;
  MAX_TOTAL_UNCOMPRESSED_BYTES: number;
  MAX_COMPRESSION_RATIO: number;
  RATIO_CHECK_MIN_BYTES: number;
  ORIGINAL_SIZE_UNAVAILABLE: string;
  checkOriginalSize(size: number | undefined, failure?: string): number;
  checkUncompressedSize(archiveBytes: number, uncompressedBytes: number): void;
  planUnknownLengthFreeSpaceProbe(
    knownTotal: number,
    writtenBefore: number,
    chunkBytes: number,
    reservedUntil: number
  ): FreeSpaceProbePlan;
}

const source = readFileSync(
  new URL('../../harmony/pushy/src/main/ets/ArchiveLimits.ts', import.meta.url),
  'utf8'
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export /gm, '');
const limits = runInNewContext(
  `${new Bun.Transpiler({ loader: 'ts' }).transformSync(source)}
({ UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES, MAX_TOTAL_UNCOMPRESSED_BYTES,
   MAX_COMPRESSION_RATIO, RATIO_CHECK_MIN_BYTES, ORIGINAL_SIZE_UNAVAILABLE,
   checkOriginalSize, checkUncompressedSize, planUnknownLengthFreeSpaceProbe });`,
  {
    ERROR_DELTA_FAILED,
    ERROR_FILE_OPERATION_FAILED,
    createPushyError,
    isReservedEntryName: (name: string) => name.startsWith('.pushy-'),
  }
) as ArchiveLimits;

const PROBE = limits.UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES;

function refusal(run: () => unknown): PushyError | null {
  try {
    run();
  } catch (e) {
    return e as PushyError;
  }
  return null;
}

// Unknown-length downloads: no write may pass a probed reservation.
describe('harmony planUnknownLengthFreeSpaceProbe', () => {
  test('never probes when the total length is known', () => {
    const plan = limits.planUnknownLengthFreeSpaceProbe(1000, 0, 4096, 0);
    expect(plan.probe).toBe(false);
    expect(plan.reservedUntil).toBe(0);
  });

  test('probes the first chunk and reserves PROBE bytes ahead', () => {
    const plan = limits.planUnknownLengthFreeSpaceProbe(0, 0, 4096, 0);
    expect({ ...plan }).toEqual({
      probe: true,
      reserve: PROBE,
      reservedUntil: PROBE,
    });
  });

  test('skips chunks that stay inside the reservation, edge included', () => {
    const plan = limits.planUnknownLengthFreeSpaceProbe(0, 4096, 4096, PROBE);
    expect(plan.probe).toBe(false);
    expect(plan.reservedUntil).toBe(PROBE);
    expect(
      limits.planUnknownLengthFreeSpaceProbe(0, PROBE - 10, 10, PROBE).probe
    ).toBe(false);
  });

  test('re-probes a chunk that would cross the reservation', () => {
    const plan = limits.planUnknownLengthFreeSpaceProbe(
      0,
      PROBE - 10,
      11,
      PROBE
    );
    expect(plan.probe).toBe(true);
    expect(plan.reservedUntil).toBe(PROBE - 10 + PROBE);
  });

  test('reserves a chunk larger than PROBE by its own size', () => {
    const big = PROBE * 2 + 1;
    const plan = limits.planUnknownLengthFreeSpaceProbe(0, 100, big, 0);
    expect({ ...plan }).toEqual({
      probe: true,
      reserve: big,
      reservedUntil: 100 + big,
    });
  });

  test('walking a stream never writes past a probed reservation', () => {
    let reservedUntil = 0;
    let written = 0;
    let probes = 0;
    const chunk = 300 * 1024;
    for (let i = 0; i < 100; i++) {
      const plan = limits.planUnknownLengthFreeSpaceProbe(
        0,
        written,
        chunk,
        reservedUntil
      );
      if (plan.probe) {
        probes += 1;
      }
      reservedUntil = plan.reservedUntil;
      written += chunk;
      expect(written).toBeLessThanOrEqual(reservedUntil);
    }
    expect(probes).toBeLessThan(100);
  });
});

// getOriginalSize unavailable: refuse (never pass through), with its own detail.
describe('harmony checkOriginalSize', () => {
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

describe('harmony checkUncompressedSize', () => {
  test('accepts sizes within the total and ratio limits', () => {
    expect(refusal(() => limits.checkUncompressedSize(1024, 4096))).toBeNull();
    // Below RATIO_CHECK_MIN_BYTES the ratio is not checked.
    expect(
      refusal(() =>
        limits.checkUncompressedSize(1, limits.RATIO_CHECK_MIN_BYTES)
      )
    ).toBeNull();
  });

  test('refuses an archive that expands beyond the total limit', () => {
    const error = refusal(() =>
      limits.checkUncompressedSize(
        limits.MAX_TOTAL_UNCOMPRESSED_BYTES,
        limits.MAX_TOTAL_UNCOMPRESSED_BYTES + 1
      )
    );
    expect(error?.code).toBe(ERROR_DELTA_FAILED);
  });

  test('refuses a whole-archive ratio above the limit', () => {
    const archive = limits.RATIO_CHECK_MIN_BYTES;
    expect(
      refusal(() =>
        limits.checkUncompressedSize(
          archive,
          archive * limits.MAX_COMPRESSION_RATIO
        )
      )
    ).toBeNull();
    expect(
      refusal(() =>
        limits.checkUncompressedSize(
          archive,
          archive * limits.MAX_COMPRESSION_RATIO + 1
        )
      )?.code
    ).toBe(ERROR_DELTA_FAILED);
  });
});
