#!/usr/bin/env node
// Guards the JS <-> native method contract against drift.
//
// src/NativePushy.ts is the single spec. The tables derived from it — the
// Harmony PUSHY_METHODS rows (Promise methods ASYNC) and the old-architecture
// NativePushySpec — are generated (scripts/generate-contract.ts); what no
// generator can write is each module's implementation, checked here: every
// spec method must be implemented on Android, iOS and Harmony. A method
// missing on one platform is `undefined` on the JS side, and the JS
// feature-detects then treat the whole capability as "old native" and skip it
// silently — exactly how the native cold-start check shipped dark on Harmony
// for three releases (docs/NATIVE_CHECK_FOLLOWUPS.md, 2026-08-13).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const spec = read('src/NativePushy.ts');
const specBody = spec.slice(spec.indexOf('interface Spec'));
// `name(args): ReturnType;` declarations at one indent level inside Spec.
const methodRe = /^\s{2}([a-zA-Z]+)\(([^)]*)\)\s*:\s*([^;]+);/gm;
const methods = [];
let m;
while ((m = methodRe.exec(specBody)) !== null) {
  methods.push({ name: m[1] });
}
if (methods.length < 10) {
  console.error('check-native-spec-parity: failed to parse src/NativePushy.ts');
  process.exit(1);
}

// Bridge plumbing that RN itself calls; not part of the Pushy surface.
const plumbing = new Set(['addListener', 'removeListeners']);

// One UpdateModule serves both Android architectures. The old bridge finds
// its methods through @ReactMethod on UpdateModule itself.
const androidModule = read(
  'android/src/main/java/cn/reactnative/modules/update/UpdateModule.java'
);
const ios = read('ios/RCTPushy/RCTPushy.mm');
const harmonyCpp = read('harmony/pushy/src/main/cpp/PushyTurboModule.cpp');
const harmonyTs = read('harmony/pushy/src/main/ets/PushyTurboModule.ts');

// The (generated) Harmony method table: `X(name, argCount, SYNC|ASYNC)` rows
// of the PUSHY_METHODS X-macro in PushyTurboModule.cpp.
const harmonyTable = new Map();
const problems = [];
const tableRe = /\bX\(\s*([A-Za-z]+)\s*,\s*(\d+)\s*,\s*(SYNC|ASYNC)\s*\)/g;
while ((m = tableRe.exec(harmonyCpp)) !== null) {
  harmonyTable.set(m[1], m[3]);
}
if (harmonyTable.size < 10) {
  console.error(
    'check-native-spec-parity: failed to parse the PUSHY_METHODS table in ' +
      'harmony/pushy/src/main/cpp/PushyTurboModule.cpp'
  );
  process.exit(1);
}

const has = (source, re) => re.test(source);

for (const { name } of methods) {
  if (plumbing.has(name)) {
    continue;
  }
  const javaRe = new RegExp(
    `@ReactMethod\\s+@Override\\s+public\\s+\\S+\\s+${name}\\s*\\(`
  );
  if (!has(androidModule, javaRe)) {
    problems.push(`android: ${name} not exported with @ReactMethod`);
  }
  if (
    !has(ios, new RegExp(`RCT_(EXPORT|REMAP)_METHOD\\(\\s*${name}\\b`)) &&
    !has(ios, new RegExp(`^-\\s*\\([^)]*\\)\\s*${name}\\b`, 'm'))
  ) {
    problems.push(`ios: ${name} not exported`);
  }
  const kind = harmonyTable.get(name);
  const tsRe = new RegExp(`^\\s{2}(?:async\\s+)?${name}\\s*\\(`, 'm');
  if (!has(harmonyTs, tsRe)) {
    problems.push(`harmony/ets: ${name} not implemented`);
  }
  // A sync registration must not wrap an async ArkTS implementation.
  const tsAsync = new RegExp(`^\\s{2}async\\s+${name}\\s*\\(`, 'm');
  if (kind === 'SYNC' && has(harmonyTs, tsAsync)) {
    problems.push(`harmony: ${name} is async in ArkTS but registered SYNC`);
  }
}

if (problems.length > 0) {
  console.error(
    `check-native-spec-parity: ${problems.length} problem(s) across ` +
      `${methods.length} spec methods`
  );
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  process.exit(1);
}
console.log(
  `check-native-spec-parity: ${methods.length} spec methods present on ` +
    'android, ios and harmony'
);
