// Shared access to the repository's native sources for the tests that check
// or evaluate them directly.
import { readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { nativeConfigsEquivalent } from '../updateFlowCore';

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

/**
 * Stand-in for the NAPI persisted-config bindings (cpp/update_flow_core
 * native_config.h) when a Harmony module is evaluated under bun. The gate is
 * a JS restatement of ParseRunnableConfig, held to the shared
 * native-config-vectors.json by nativeHostApi.test.ts; equivalence reuses the
 * JS client's C1 implementation, which replays the same vectors as the core.
 */
export const harmonyConfigBindings = {
  configsEquivalent: (a?: string, b?: string): boolean =>
    a !== undefined && b !== undefined && nativeConfigsEquivalent(a, b),
  runnableConfig: (json?: string): string => {
    if (!json) {
      return JSON.stringify({ status: 'skipped', reason: 'not_configured' });
    }
    const invalid = JSON.stringify({
      status: 'failed',
      reason: 'invalid_config',
    });
    let config: unknown;
    try {
      config = JSON.parse(json);
    } catch {
      return invalid;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return invalid;
    }
    const { appKey, disabled } = config as Record<string, unknown>;
    if (disabled) {
      return JSON.stringify({ status: 'skipped', reason: 'disabled' });
    }
    const trimmed = typeof appKey === 'string' ? appKey.trim() : '';
    return trimmed ? JSON.stringify({ appKey: trimmed }) : invalid;
  },
};

/**
 * The exports of harmony/pushy/src/main/ets/StoreSchema.ts (the generated
 * keys and the store mapping), for modules evaluated with their imports
 * stripped.
 */
export const harmonyStoreSchema = (
  logger: Record<string, (...args: unknown[]) => void> = {
    info() {},
    warn() {},
    error() {},
  }
): Record<string, unknown> => {
  const names = [
    ...source('harmony/pushy/src/main/ets/StoreSchema.ts').matchAll(
      /^export (?:const|function) (\w+)/gm
    ),
  ].map((match) => match[1]);
  return evalHarmonyModule('StoreSchema.ts', `({ ${names.join(', ')} })`, {
    logger,
  }) as Record<string, unknown>;
};
