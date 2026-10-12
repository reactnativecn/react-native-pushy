#!/usr/bin/env node
// Guards the JS <-> native method contract against drift.
//
// src/NativePushy.ts is the single spec. Every method it declares must be
// exposed by all four native bindings, and the Harmony C++ method table must
// register Promise-returning methods as ASYNC (a Promise handed through a
// SYNC registration reaches JS as an empty object and its rejection is lost).
// A method missing on one platform is `undefined` on the JS side, and the JS
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
  methods.push({ name: m[1], returns: m[3].trim() });
}
if (methods.length < 10) {
  console.error('check-native-spec-parity: failed to parse src/NativePushy.ts');
  process.exit(1);
}

// Bridge plumbing that RN itself calls; not part of the Pushy surface.
const plumbing = new Set(['addListener', 'removeListeners']);

// One UpdateModule serves both Android architectures. The old bridge finds
// its methods through @ReactMethod on UpdateModule itself; under the old
// architecture it extends the hand-written NativePushySpec stand-in, which
// must declare every method the codegen spec does.
const androidModule = read(
  'android/src/main/java/cn/reactnative/modules/update/UpdateModule.java'
);
const oldarchSpec = read(
  'android/src/oldarch/cn/reactnative/modules/update/NativePushySpec.java'
);
const ios = read('ios/RCTPushy/RCTPushy.mm');
const harmonyCpp = read('harmony/pushy/src/main/cpp/PushyTurboModule.cpp');
const harmonyTs = read('harmony/pushy/src/main/ets/PushyTurboModule.ts');

// The Harmony method table: `X(name, argCount, SYNC|ASYNC)` rows of the
// PUSHY_METHODS X-macro in PushyTurboModule.cpp.
const harmonyTable = new Map();
const problems = [];
const tableRe = /\bX\(\s*([A-Za-z]+)\s*,\s*(\d+)\s*,\s*(SYNC|ASYNC)\s*\)/g;
while ((m = tableRe.exec(harmonyCpp)) !== null) {
  if (harmonyTable.has(m[1])) {
    problems.push(`harmony/cpp: ${m[1]} listed twice in PUSHY_METHODS`);
  }
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

for (const { name, returns } of methods) {
  if (plumbing.has(name)) {
    continue;
  }
  const javaRe = new RegExp(
    `@ReactMethod\\s+@Override\\s+public\\s+\\S+\\s+${name}\\s*\\(`
  );
  if (!has(androidModule, javaRe)) {
    problems.push(`android: ${name} not exported with @ReactMethod`);
  }
  const specRe = new RegExp(`public\\s+abstract\\s+\\S+\\s+${name}\\s*\\(`);
  if (!has(oldarchSpec, specRe)) {
    problems.push(`android/oldarch: ${name} missing from NativePushySpec`);
  }
  if (
    !has(ios, new RegExp(`RCT_(EXPORT|REMAP)_METHOD\\(\\s*${name}\\b`)) &&
    !has(ios, new RegExp(`^-\\s*\\([^)]*\\)\\s*${name}\\b`, 'm'))
  ) {
    problems.push(`ios: ${name} not exported`);
  }
  const kind = harmonyTable.get(name);
  if (!kind) {
    problems.push(`harmony/cpp: ${name} not in the PUSHY_METHODS table`);
  }
  const isPromise = /^Promise</.test(returns);
  if (isPromise && kind === 'SYNC') {
    problems.push(
      `harmony/cpp: ${name} returns ${returns} in the spec but is ` +
        'registered SYNC in PUSHY_METHODS'
    );
  }
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
    'android (old+new arch), ios and harmony'
);
