#!/usr/bin/env node
// Asserts that the "hand-kept mirrors" of the shared C++ headers (ArkTS,
// Java, JS) still carry the same values. Plain Node, no SDK: runs in
// `bun lint` on every PR so a limit or code bumped in cpp/patch_core cannot
// silently drift on Harmony, Android or the JS layer.
//
//   cpp/patch_core/archive_limits.h  <-> harmony/.../ArchiveLimits.ts
//                                        android/.../ArchiveLimits.java
//   cpp/patch_core/install_record.h  <-> harmony/.../InstallRecord.ts
//                                        android/.../InstallRecord.java
//                                        (only the constants a pair lists
//                                        under `only`)
//   cpp/patch_core/error_codes.h     <-> harmony/.../ErrorCodes.ts
//                                        android/.../ErrorCodes.java
//                                        src/error.ts (every native code must
//                                        be a known UpdateErrorCode)
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function collect(re, source, nameGroup, valueGroup) {
  const values = new Map();
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[nameGroup];
    values.set(name, evaluate(match[valueGroup].trim(), name));
  }
  return values;
}

// `constexpr <type> kName = <expr>;` — the value is either a string literal or
// an integer expression built from literals, `*`, `+`, parentheses and the
// LL suffix.
const parseCppConstants = (source) =>
  collect(
    /(?:constexpr|inline)\s+(?:const\s+)?(?:long\s+long|int|char\s*\*)\s*(?:const\s+)?k([A-Za-z0-9]+)\s*=\s*([^;]+);/g,
    source,
    1,
    2
  );

// `export const NAME = <expr>;`
const parseArkTsConstants = (source) =>
  collect(
    /export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[a-z]+)?\s*=\s*([^;]+);/g,
    source,
    1,
    2
  );

// `static final <type> NAME = <expr>;`
const parseJavaConstants = (source) =>
  collect(
    /static\s+final\s+(?:long|int|String)\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g,
    source,
    1,
    2
  );

// Every quoted UPPER_SNAKE string literal, whatever the surrounding shape
// (union type, Set, `as const` array): the JS layer only has to *know* each
// native code; it also carries JS-only codes of its own.
function parseJsStringLiterals(source) {
  const re = /(["'`])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\1/g;
  const values = new Map();
  let match;
  while ((match = re.exec(source)) !== null) {
    values.set(match[2], match[2]);
  }
  return values;
}

// Encoded text (obscured_text.h / Texts.ts / Texts.java,
// scripts/encode-native-text.ts): byte i XORed with (0x5A + 0x1D * i) & 0xFF.
function reveal(hex) {
  let text = '';
  for (let i = 0; i < hex.length / 2; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    text += String.fromCharCode(byte ^ ((0x5a + 0x1d * i) & 0xff));
  }
  return text;
}

function evaluate(expression, name) {
  const text = expression.replace(/\s+/g, ' ').trim();
  const encoded = text.match(
    /^(?:text::RevealStatic|revealText|Texts\.reveal|reveal)\((["'])([0-9a-f]+)\1\)$/
  );
  if (encoded) {
    return reveal(encoded[2]);
  }
  const stringLiteral = text.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (stringLiteral) {
    return stringLiteral[2];
  }
  // C++ `LL` / Java `L` integer suffixes.
  const numeric = text.replace(/(\d)L{1,2}\b/g, '$1');
  if (!/^[\d\s()*+]+$/.test(numeric)) {
    throw new Error(`check-constant-parity: cannot evaluate ${name} = ${text}`);
  }
  // Only digits and arithmetic operators survive the regex above.
  return Function(`"use strict"; return (${numeric});`)();
}

// kMaxArchiveBytes -> MAX_ARCHIVE_BYTES
function screamingSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const javaDir = 'android/src/main/java/cn/reactnative/modules/update';
// Must always be parsed from the header (guards the parser itself: a regex
// regression would otherwise silently drop the pair's coverage).
const archiveLimitsRequired = ['UnknownLengthFreeSpaceProbeBytes', 'MaxArchiveBytes'];
const errorCodesRequired = ['DeltaFailed', 'InvalidOptions'];
// The record logic itself lives in install_record.cpp; the hosts only mirror
// the names they still build paths from.
const installRecordMirrored = ['Schema', 'FileName', 'StagingSuffix'];

const pairs = [
  {
    header: 'cpp/patch_core/archive_limits.h',
    mirror: 'harmony/pushy/src/main/ets/ArchiveLimits.ts',
    parse: parseArkTsConstants,
    mirrorName: screamingSnake,
    required: archiveLimitsRequired,
  },
  {
    header: 'cpp/patch_core/archive_limits.h',
    mirror: `${javaDir}/ArchiveLimits.java`,
    parse: parseJavaConstants,
    mirrorName: screamingSnake,
    required: archiveLimitsRequired,
  },
  {
    header: 'cpp/patch_core/install_record.h',
    mirror: 'harmony/pushy/src/main/ets/InstallRecord.ts',
    parse: parseArkTsConstants,
    mirrorName: (cppName) =>
      ({
        Schema: 'INSTALL_RECORD_SCHEMA',
        FileName: 'INSTALL_RECORD_FILE_NAME',
        StagingSuffix: 'STAGING_SUFFIX',
      })[cppName] || screamingSnake(cppName),
    only: installRecordMirrored,
  },
  {
    header: 'cpp/patch_core/install_record.h',
    mirror: `${javaDir}/InstallRecord.java`,
    parse: parseJavaConstants,
    mirrorName: screamingSnake,
    only: installRecordMirrored,
  },
  {
    header: 'cpp/patch_core/error_codes.h',
    mirror: 'harmony/pushy/src/main/ets/ErrorCodes.ts',
    parse: parseArkTsConstants,
    mirrorName: (cppName) => `ERROR_${screamingSnake(cppName)}`,
    required: errorCodesRequired,
    // Every ERROR_* export must exist in the header too (no invented codes).
    mirrorPrefix: 'ERROR_',
  },
  {
    header: 'cpp/patch_core/error_codes.h',
    mirror: `${javaDir}/ErrorCodes.java`,
    parse: parseJavaConstants,
    mirrorName: screamingSnake,
    required: errorCodesRequired,
    // Every constant in the class must exist in the header too.
    mirrorPrefix: '',
  },
  {
    header: 'cpp/patch_core/error_codes.h',
    mirror: 'src/error.ts',
    parse: parseJsStringLiterals,
    required: errorCodesRequired,
    // The literal *is* the code: look each one up by the header's value.
    byValue: true,
  },
];

const problems = [];
let checked = 0;

for (const pair of pairs) {
  const cpp = parseCppConstants(read(pair.header));
  const mirror = pair.parse(read(pair.mirror));
  if (cpp.size === 0) {
    problems.push(`${pair.header}: no constexpr constants parsed`);
    continue;
  }
  for (const name of [...(pair.required || []), ...(pair.only || [])]) {
    if (!cpp.has(name)) {
      problems.push(`${pair.header}: k${name} not parsed (required)`);
    }
  }
  for (const [cppName, cppValue] of cpp) {
    if (pair.only && !pair.only.includes(cppName)) {
      continue;
    }
    const mirrorName = pair.byValue ? cppValue : pair.mirrorName(cppName);
    checked += 1;
    if (!mirror.has(mirrorName)) {
      problems.push(
        `${pair.mirror}: missing ${mirrorName} (k${cppName} in ${pair.header})`
      );
      continue;
    }
    const mirrorValue = mirror.get(mirrorName);
    if (mirrorValue !== cppValue) {
      problems.push(
        `${pair.mirror}: ${mirrorName} = ${JSON.stringify(mirrorValue)} but ` +
          `${pair.header} k${cppName} = ${JSON.stringify(cppValue)}`
      );
    }
  }
  if (pair.mirrorPrefix !== undefined) {
    const known = new Set(Array.from(cpp.keys()).map(pair.mirrorName));
    for (const name of mirror.keys()) {
      if (name.startsWith(pair.mirrorPrefix) && !known.has(name)) {
        problems.push(`${pair.mirror}: ${name} has no counterpart in ${pair.header}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-constant-parity: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(
  `check-constant-parity: ${checked} constants match across ${pairs.length} header/mirror pairs`
);
