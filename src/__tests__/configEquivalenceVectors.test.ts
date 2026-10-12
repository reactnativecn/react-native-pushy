import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import vectorsFile from '../../cpp/update_flow_core/tests/config-equivalence-vectors.json';
import { nativeConfigsEquivalent } from '../updateFlowCore';

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
function harmonyEquivalence(): (a: string, b: string) => boolean {
  const source = readFileSync(
    new URL(
      '../../harmony/pushy/src/main/ets/UpdateContext.ts',
      import.meta.url
    ),
    'utf8'
  )
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export\s*\{[^}]*\}(?:\s*from\s*[^;]*)?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  return runInNewContext(`${js}\nnativeConfigsEquivalent;`, {});
}

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
