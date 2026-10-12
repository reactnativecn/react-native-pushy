#!/usr/bin/env node
/**
 * Type-checks the HarmonyOS TS sources (harmony/pushy/src/main/ets/*.ts) with
 * a strict tsc pass.
 *
 * The root tsconfig excludes harmony/ because these files need the HarmonyOS
 * SDK type declarations (@ohos.* / @kit.*); the RNOH surface and the NAPI
 * module are stubbed in harmony/types, so oh_modules is not needed. This
 * script locates an OpenHarmony SDK, generates a tsconfig with the right
 * path mappings and runs tsc against it.
 *
 * Without an SDK (developer machines without DevEco) the check is skipped
 * with a notice. With HARMONY_TYPECHECK_REQUIRED=1 (the harmony-build CI
 * container) a missing SDK fails instead, and the search also walks the
 * container's install roots.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const harmonyDir = path.join(repoRoot, 'harmony');
const generatedConfigPath = path.join(harmonyDir, '.tsconfig.harmony.json');
const required = process.env.HARMONY_TYPECHECK_REQUIRED === '1';

// Install roots of the CI image, whose SDK is not laid out like a DevEco
// install. Only searched (first) when the check is required: walking them
// is slow.
const containerRoots = [
  process.env.DEVECO_SDK_HOME,
  '/opt',
  '/usr/local',
  '/usr/lib',
  '/root',
  '/home',
  '/github/home',
];
const CONTAINER_SEARCH_DEPTH = 8;

// Every `<dir>/openharmony/ets/api` directory under root, at most `depth`
// levels down (symlinks are not followed). The @ohos.*/@kit.* declarations
// live under the OpenHarmony SDK; the sibling hms/ets tree only holds HMS
// kits and must not win.
function findOpenHarmonyApiDirs(root, depth) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (
        entry.name === 'api' &&
        path.basename(dir) === 'ets' &&
        path.basename(path.dirname(dir)) === 'openharmony'
      ) {
        found.push(child);
        continue;
      }
      walk(child, level + 1);
    }
  };
  walk(root, 1);
  return found.sort();
}

function findSdkEtsDir() {
  // CI containers lay the SDK out differently from DevEco; let them point
  // straight at the `ets` directory (the one containing `api/` and `kits/`).
  const explicit = process.env.HARMONY_SDK_ETS_DIR;
  if (explicit) {
    if (fs.existsSync(path.join(explicit, 'api'))) {
      return explicit;
    }
    // A stale override must not hide a valid DEVECO_SDK_HOME / default
    // install: say so and keep probing.
    console.warn(
      `check-harmony-types: HARMONY_SDK_ETS_DIR=${explicit} has no api/ dir; ` +
        'ignoring it and probing the default SDK locations.'
    );
  }
  if (required) {
    // The CI image: the first OpenHarmony declaration root under its
    // install roots, in root order.
    for (const root of containerRoots) {
      if (!root || !fs.existsSync(root)) {
        continue;
      }
      const [apiDir] = findOpenHarmonyApiDirs(root, CONTAINER_SEARCH_DEPTH);
      if (apiDir) {
        return path.dirname(apiDir);
      }
    }
  }
  const bases = [];
  if (process.env.DEVECO_SDK_HOME) {
    bases.push(process.env.DEVECO_SDK_HOME);
  }
  bases.push(
    '/Applications/DevEco-Studio.app/Contents/sdk',
    path.join(process.env.HOME || '', 'Library/OpenHarmony/Sdk')
  );

  for (const base of bases) {
    if (!base || !fs.existsSync(base)) {
      continue;
    }
    const candidates = [path.join(base, 'default', 'openharmony', 'ets')];
    // Version-numbered SDK layouts (e.g. ~/Library/OpenHarmony/Sdk/11/ets).
    for (const entry of fs.readdirSync(base)) {
      candidates.push(
        path.join(base, entry, 'openharmony', 'ets'),
        path.join(base, entry, 'ets')
      );
    }
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'api'))) {
        return candidate;
      }
    }
  }
  return null;
}

// A missing SDK skips the check, except where it is required (CI), where it
// is a misconfiguration and must fail instead of silently passing.
const skipOrFail = (reason) => {
  if (required) {
    console.error(`check-harmony-types: ${reason} (required in CI).`);
    process.exit(1);
  }
  console.log(`check-harmony-types: ${reason}, skipping harmony type check.`);
  process.exit(0);
};

const sdkEts = findSdkEtsDir();
if (!sdkEts) {
  skipOrFail(
    'no DevEco/OpenHarmony SDK found (set DEVECO_SDK_HOME or ' +
      'HARMONY_SDK_ETS_DIR to enable)'
  );
}
console.log(`check-harmony-types: using SDK declarations in ${sdkEts}`);

const config = {
  compilerOptions: {
    target: 'ES2021',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2021'],
    types: [],
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    forceConsistentCasingInFileNames: true,
    paths: {
      // @rnoh and librnpushy.so are stubbed in types/ (see comments there);
      // @ohos/@kit resolve to the real SDK declarations.
      '@ohos.*': [path.join(sdkEts, 'api', '@ohos.*')],
      '@kit.*': [path.join(sdkEts, 'kits', '@kit.*')],
    },
  },
  include: ['pushy/src/main/ets/**/*.ts', 'types/**/*.d.ts'],
};

fs.writeFileSync(generatedConfigPath, JSON.stringify(config, null, 2));

const tscBin = path.join(
  path.dirname(
    require.resolve('typescript/package.json', { paths: [repoRoot] })
  ),
  'bin/tsc'
);
const result = spawnSync(
  process.execPath,
  [tscBin, '-p', generatedConfigPath],
  {
    stdio: 'inherit',
  }
);

if (result.status !== 0) {
  console.error('check-harmony-types: harmony type check failed.');
  process.exit(result.status || 1);
}
console.log('check-harmony-types: harmony type check passed.');
