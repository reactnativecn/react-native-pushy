#!/usr/bin/env node
// Guards the published file list (npm pack --dry-run) against drift: the
// package.json `files` whitelist decides what ships, this check decides what
// must and must not be there. Run in lint CI and right before `npm publish`
// (with --release, which additionally requires the Harmony HAR).
const { execFileSync } = require('child_process');
const { files: filesField } = require('../package.json');

const release = process.argv.includes('--release');

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
  'android/build.gradle',
  'android/src/main/java/cn/reactnative/modules/update/UpdateContext.java',
  'android/jni/hpatch.c',
  'ios/RCTPushy/RCTPushy.mm',
  'ios/RCTPushy/RCTPushyOrchestrator.mm',
  'react-native-update.podspec',
  'cpp/patch_core/patch_core.cpp',
  'cpp/patch_core/archive_limits.h',
  'cpp/patch_core/install_record.h',
  'cpp/update_flow_core/update_flow_core.cpp',
  'harmony/pushy/src/main/ets/PushyTurboModule.ts',
  'harmony/hvigor-plugin.ts',
  'expo-module.config.json',
  'react-native.config.js',
  ...(release ? ['harmony/pushy.har'] : []),
];
const requiredAbis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

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
  `check-packlist: ${files.length} files OK${release ? ' (release)' : ''}`
);
