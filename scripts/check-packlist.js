#!/usr/bin/env node
// Guards the published file list (npm pack --dry-run) against drift: the
// package.json `files` whitelist decides what ships, this check decides what
// must and must not be there. Run in lint CI and right before `npm publish`
// (with --release, which additionally requires the Harmony HAR).
const { execFileSync } = require('child_process');
const { files: filesField, types } = require('../package.json');

const release = process.argv.includes('--release');
// Also compile the packed native sources (needs the submodules and a C
// compiler; test.yml's C++ job runs it).
const compile = process.argv.includes('--compile');

// A `files` entry (glob, file or directory) as a regex over packed paths:
// the entry itself or anything below it.
function entryPattern(entry) {
  const source = entry
    .replace(/\/+$/, '')
    .split(/(\*\*\/?|\*)/)
    .map((part) => {
      if (part === '**' || part === '**/') {
        return '(?:.*/)?';
      }
      if (part === '*') {
        return '[^/]*';
      }
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}(/|$)`);
}

// Derived from package.json `files` (the single list of what ships), plus
// package.json which npm always packs. Negated entries must not show up.
const allowed = ['package.json', ...filesField.filter((f) => !f.startsWith('!'))].map(
  entryPattern
);
const excluded = filesField
  .filter((f) => f.startsWith('!'))
  .map((f) => ({ entry: f, re: entryPattern(f.slice(1)) }));

const forbidden = [
  /(^|\/)(tests?|__tests__)\//,
  /(^|\/)(build|oh_modules|node_modules|\.hvigor|\.cxx|\.gradle)(\/|$)/,
  /^Example\//,
  /^scripts\//,
  /^\.github\//,
  /^\.gitmodules$/,
  /^biome\.json$/,
  /^docs\//,
  /^CODE_AUDIT\.md$/,
  /\.(log|tgz|zip|ppk|apk)$/,
];

const required = [
  'package.json',
  'src/index.ts',
  'src/NativePushy.ts',
  // The declarations apps type-check against (bun build:types emits them).
  // --compile runs in test.yml's C++ job, which has no JS toolchain to
  // build them; the lint workflow and the publish action check them.
  ...(compile ? [] : [types]),
  'android/build.gradle',
  'android/src/main/java/cn/reactnative/modules/update/UpdateContext.java',
  'ios/RCTPushy/RCTPushy.mm',
  'ios/RCTPushy/RCTPushyOrchestrator.mm',
  'react-native-update.podspec',
  // The shared cores iOS (podspec Core) and Harmony (CMakeLists.txt) compile
  // from the package by directory.
  'cpp/patch_core/patch_core.cpp',
  'cpp/patch_core/archive_limits.h',
  'cpp/patch_core/install_record.h',
  'cpp/update_flow_core/update_flow_core.cpp',
  'cpp/hpatch/hpatch.c',
  'cpp/hpatch/hpatch.h',
  'harmony/pushy/src/main/ets/PushyTurboModule.ts',
  'harmony/hvigor-plugin.ts',
  'expo-module.config.json',
  'react-native.config.js',
  ...(release
    ? [
        'harmony/pushy.har',
        // Submodule sources hpatch.c decodes with (lint CI checks out
        // without submodules; the publish jobs check them out).
        // <generated:vendored-sources> (scripts/contract.ts; bun scripts/generate-contract.ts)
        'android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c',
        'android/jni/HDiffPatch/file_for_patch.c',
        'android/jni/lzma/C/LzmaDec.c',
        'android/jni/lzma/C/Lzma2Dec.c',
        // </generated:vendored-sources>
        // The submodules ship only these sources and headers, so their
        // licenses must ship with them.
        'android/jni/HDiffPatch/LICENSE',
        'android/jni/lzma/DOC/lzma-sdk.txt',
      ]
    : []),
];
// <generated:abis> (scripts/contract.ts; bun scripts/generate-contract.ts)
const requiredAbis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
// </generated:abis>

const json = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
);
// npm <= 11 prints an array of packed tarballs; npm 12 prints an object
// keyed by package name. Accept both.
const parsed = JSON.parse(json);
const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = packed.files.map((f) => f.path);
const set = new Set(files);
const problems = [];

for (const file of files) {
  if (!allowed.some((re) => re.test(file))) {
    problems.push(`not whitelisted: ${file}`);
  }
  const hit = excluded.find(({ re }) => re.test(file));
  if (hit) {
    problems.push(`excluded by "${hit.entry}" but packed: ${file}`);
  }
  if (forbidden.some((re) => re.test(file))) {
    problems.push(`forbidden: ${file}`);
  }
}
for (const file of required) {
  if (!set.has(file)) {
    problems.push(`missing: ${file}`);
  }
}
for (const abi of requiredAbis) {
  if (!set.has(`android/lib/${abi}/librnpushy.so`)) {
    problems.push(`missing: android/lib/${abi}/librnpushy.so`);
  }
}

// The package must compile on its own (--compile): `files` lists the submodule
// sources and headers one by one (the rest of HDiffPatch / lzma does not
// ship), and the e2e builds copy the source tree, so they would not notice a
// header missing from the list. Unpack the real tarball and syntax-check the
// C sources the podspec (and Harmony's CMakeLists.txt) compile, plus the
// cores that include them, using only the unpacked files.
function compilePackedSources() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnu-packlist-'));
  try {
    const out = execFileSync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', dir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const result = JSON.parse(out);
    const tarball = (Array.isArray(result) ? result[0] : Object.values(result)[0])
      .filename;
    execFileSync('tar', ['-xzf', path.join(dir, path.basename(tarball)), '-C', dir]);
    const root = path.join(dir, 'package');
    const sources = [
      // <generated:vendored-compile> (scripts/contract.ts; bun scripts/generate-contract.ts)
      'android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c',
      'android/jni/HDiffPatch/file_for_patch.c',
      'android/jni/lzma/C/LzmaDec.c',
      'android/jni/lzma/C/Lzma2Dec.c',
      // </generated:vendored-compile>
      ...fs
        .readdirSync(path.join(root, 'cpp/hpatch'))
        .filter((name) => name.endsWith('.c'))
        .map((name) => `cpp/hpatch/${name}`),
    ];
    const cxxSources = fs
      .readdirSync(path.join(root, 'cpp/patch_core'))
      .filter((name) => name.endsWith('.cpp'))
      .map((name) => `cpp/patch_core/${name}`);
    for (const source of sources) {
      try {
        execFileSync('cc', ['-fsyntax-only', source], { cwd: root, stdio: 'pipe' });
      } catch (e) {
        problems.push(`packed ${source} does not compile: ${String(e.stderr).trim()}`);
      }
    }
    for (const source of cxxSources) {
      try {
        execFileSync('c++', ['-std=c++17', '-fsyntax-only', source], {
          cwd: root,
          stdio: 'pipe',
        });
      } catch (e) {
        problems.push(`packed ${source} does not compile: ${String(e.stderr).trim()}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (compile && problems.length === 0) {
  compilePackedSources();
}

if (problems.length > 0) {
  console.error(
    `check-packlist: ${problems.length} problem(s) in ${files.length} files`
  );
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  process.exit(1);
}
console.log(
  `check-packlist: ${files.length} files OK${release ? ' (release)' : ''}` +
    `${compile ? ', packed native sources compile' : ''}`
);
