import { describe, it, expect } from '@ohos/hypium';
import {
  ORIGINAL_SIZE_UNAVAILABLE,
  UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES,
  checkOriginalSize,
  planUnknownLengthFreeSpaceProbe,
} from '../main/ets/ArchiveLimits';
import { ERROR_DELTA_FAILED, PushyError } from '../main/ets/ErrorCodes';

const PROBE = UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES;

function refusal(run: () => number): PushyError | null {
  try {
    run();
  } catch (e) {
    return e as PushyError;
  }
  return null;
}

export default function archiveLimitsTest() {
  // 未知长度下载的磁盘探测:任何写入都不得越过已探测预留的位置。
  describe('planUnknownLengthFreeSpaceProbe', () => {
    it('never probes when the total length is known', 0, () => {
      const plan = planUnknownLengthFreeSpaceProbe(1000, 0, 4096, 0);
      expect(plan.probe).assertFalse();
      expect(plan.reservedUntil).assertEqual(0);
    });

    it('probes the first chunk and reserves PROBE bytes ahead', 0, () => {
      const plan = planUnknownLengthFreeSpaceProbe(0, 0, 4096, 0);
      expect(plan.probe).assertTrue();
      expect(plan.reserve).assertEqual(PROBE);
      expect(plan.reservedUntil).assertEqual(PROBE);
    });

    it('skips chunks that stay inside the reservation', 0, () => {
      const plan = planUnknownLengthFreeSpaceProbe(0, 4096, 4096, PROBE);
      expect(plan.probe).assertFalse();
      expect(plan.reservedUntil).assertEqual(PROBE);
      // Ending exactly on the reserved boundary is still covered.
      const edge = planUnknownLengthFreeSpaceProbe(0, PROBE - 10, 10, PROBE);
      expect(edge.probe).assertFalse();
    });

    it('re-probes a chunk that would cross the reservation', 0, () => {
      const plan = planUnknownLengthFreeSpaceProbe(0, PROBE - 10, 11, PROBE);
      expect(plan.probe).assertTrue();
      expect(plan.reservedUntil).assertEqual(PROBE - 10 + PROBE);
    });

    it('reserves a chunk larger than PROBE by its own size', 0, () => {
      const big = PROBE * 2 + 1;
      const plan = planUnknownLengthFreeSpaceProbe(0, 100, big, 0);
      expect(plan.probe).assertTrue();
      expect(plan.reserve).assertEqual(big);
      expect(plan.reservedUntil).assertEqual(100 + big);
    });

    it('walking a stream never writes past a probed reservation', 0, () => {
      let reservedUntil = 0;
      let written = 0;
      let probes = 0;
      const chunk = 300 * 1024;
      for (let i = 0; i < 100; i++) {
        const plan = planUnknownLengthFreeSpaceProbe(0, written, chunk, reservedUntil);
        if (plan.probe) {
          probes += 1;
        }
        reservedUntil = plan.reservedUntil;
        written += chunk;
        expect(written <= reservedUntil).assertTrue();
      }
      expect(probes < 100).assertTrue();
    });
  });

  // getOriginalSize 读不到:拒绝(不放行),且带专属错误细节可诊断。
  describe('checkOriginalSize', () => {
    it('passes a finite non-negative size through', 0, () => {
      expect(checkOriginalSize(0)).assertEqual(0);
      expect(checkOriginalSize(12345)).assertEqual(12345);
    });

    it('refuses when getOriginalSize threw, with its own detail', 0, () => {
      const error = refusal(() => checkOriginalSize(undefined, 'boom'));
      expect(error !== null).assertTrue();
      expect(error!.code).assertEqual(ERROR_DELTA_FAILED);
      expect(error!.message.includes(ORIGINAL_SIZE_UNAVAILABLE)).assertTrue();
      expect(error!.message.includes('getOriginalSize failed: boom')).assertTrue();
    });

    it('refuses an unusable result, distinct from the thrown case', 0, () => {
      const sizes: (number | undefined)[] = [undefined, NaN, -1, Infinity];
      for (const size of sizes) {
        const error = refusal(() => checkOriginalSize(size));
        expect(error !== null).assertTrue();
        expect(error!.code).assertEqual(ERROR_DELTA_FAILED);
        expect(error!.message.includes(ORIGINAL_SIZE_UNAVAILABLE)).assertTrue();
        expect(error!.message.includes('getOriginalSize returned')).assertTrue();
      }
    });
  });
}
