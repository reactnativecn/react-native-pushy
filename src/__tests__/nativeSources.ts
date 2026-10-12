// Shared access to the repository's native sources for the tests that check
// or evaluate them directly.
import { readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';

/** The repository root. */
export const root = new URL('../../', import.meta.url);

/** A repository file's text, by its path from the root. */
export const source = (path: string) =>
  readFileSync(new URL(path, root), 'utf8');

/** Drops block and line comments (not `//` inside URLs or strings). */
export const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');

/** Root-relative paths of the native source files shipped from `dir`. */
export const shippedNativeSources = (dir: string): string[] =>
  readdirSync(new URL(dir, root), { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.(?:h|m|mm|java|kt|ts|ets|cpp)$/.test(entry.name)
    )
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.slice(
        new URL(dir, root).pathname.length - dir.length
      )
    )
    .filter((path) => !/\/tests?\//.test(path));

const harmonyScripts = new Map<string, string>();

/**
 * Evaluates a Harmony module (harmony/pushy/src/main/ets/<file>) in an
 * isolated VM context and returns the value of `expression` evaluated after
 * it. Imports are stripped, so everything the code under test imports must
 * be supplied through `context`.
 */
export const evalHarmonyModule = (
  file: string,
  expression: string,
  context: Record<string, unknown> = {}
) => {
  let js = harmonyScripts.get(file);
  if (js === undefined) {
    const ts = source(`harmony/pushy/src/main/ets/${file}`)
      .replace(/^import[\s\S]*?;\r?\n/gm, '')
      .replace(/^export\s*\{[^}]*\}(?:\s*from\s*[^;]*)?;\r?\n/gm, '')
      .replace(/^export /gm, '');
    js = new Bun.Transpiler({ loader: 'ts' }).transformSync(ts);
    harmonyScripts.set(file, js);
  }
  return runInNewContext(`${js}\n${expression}`, context);
};
