import { describe, expect, test } from 'bun:test';
import vectorsFile from '../../cpp/update_flow_core/tests/config-equivalence-vectors.json';
import { nativeConfigsEquivalent } from '../updateFlowCore';

// Contract C1 (native config equivalence) is implemented twice: here, and in
// the shared native core (cpp/update_flow_core ConfigsEquivalent, used by
// Android, iOS and Harmony). Both replay the same committed vectors; this file
// covers the TypeScript one, scripts/test-update-flow-core.sh the core.
interface Vector {
  name: string;
  a: string;
  b: string;
  equivalent: boolean;
}
const vectors = vectorsFile.cases as Vector[];

describe('C1 config equivalence vectors', () => {
  test('vector file is well formed', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    expect(vectors.some((v) => v.equivalent)).toBe(true);
    expect(vectors.some((v) => !v.equivalent)).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, () => {
      expect(nativeConfigsEquivalent(vector.a, vector.b)).toBe(
        vector.equivalent
      );
      expect(nativeConfigsEquivalent(vector.b, vector.a)).toBe(
        vector.equivalent
      );
    });
  }
});
