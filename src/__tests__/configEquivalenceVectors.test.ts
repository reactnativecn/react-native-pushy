import { describe, expect, test } from 'bun:test';
import vectorsFile from '../../cpp/update_flow_core/tests/config-equivalence-vectors.json';
import { nativeConfigsEquivalent } from '../updateFlowCore';
import { evalHarmonyModule } from './nativeSources';

// Contract C1 (native config equivalence) is implemented four times: here,
// Harmony UpdateContext.ts, Android ConfigEquivalence.java and iOS
// PushyConfigsEquivalent. All four replay the same committed vectors; this
// file covers the two TypeScript ones, ConfigEquivalenceTest (JUnit) and
// scripts/test-ios-purge-restore.sh the natives.
interface Vector {
  name: string;
  a: string;
  b: string;
  equivalent: boolean;
}
const vectors = vectorsFile.cases as Vector[];

// UpdateContext.ts imports @ohos modules, so it is evaluated with its imports
// stripped (as in nativeConfiguration.test.ts); the C1 functions only depend
// on the file's own source.
const harmonyEquivalence = (): ((a: string, b: string) => boolean) =>
  evalHarmonyModule('UpdateContext.ts', 'nativeConfigsEquivalent;');

const implementations: Array<[string, (a: string, b: string) => boolean]> = [
  ['js', nativeConfigsEquivalent],
  ['harmony', harmonyEquivalence()],
];

describe('C1 config equivalence vectors', () => {
  test('vector file is well formed', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    expect(vectors.some((v) => v.equivalent)).toBe(true);
    expect(vectors.some((v) => !v.equivalent)).toBe(true);
  });

  for (const [platform, equivalent] of implementations) {
    describe(platform, () => {
      for (const vector of vectors) {
        test(vector.name, () => {
          expect(equivalent(vector.a, vector.b)).toBe(vector.equivalent);
          expect(equivalent(vector.b, vector.a)).toBe(vector.equivalent);
        });
      }
    });
  }
});
