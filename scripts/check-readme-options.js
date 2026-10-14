#!/usr/bin/env node
// Asserts that every ClientOptions key (src/type.ts) has a row in the Options
// reference table of both READMEs: a key added to the type without a row is
// an option users cannot discover. A row's first cell may name several keys
// (`beforeCheckUpdate` / `afterCheckUpdate`). Runs in `bun lint`.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const typeSource = read('src/type.ts');
const body = typeSource.match(/export interface ClientOptions \{([\s\S]*?)\n\}/);
if (!body) {
  console.error('check-readme-options: ClientOptions not found in src/type.ts');
  process.exit(1);
}
const keys = [...body[1].matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]);
// Guards the parser itself: a regex regression must not pass silently.
for (const required of ['appKey', 'updateStrategy', 'nativeConfigSource']) {
  if (!keys.includes(required)) {
    console.error(`check-readme-options: parser did not find ${required} in ClientOptions`);
    process.exit(1);
  }
}

const problems = [];
for (const readme of ['README.md', 'README-CN.md']) {
  const documented = new Set();
  for (const line of read(readme).split('\n')) {
    const firstCell = line.match(/^\|([^|]*)\|/);
    if (!firstCell) {
      continue;
    }
    for (const name of firstCell[1].matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) {
      documented.add(name[1]);
    }
  }
  for (const key of keys) {
    if (!documented.has(key)) {
      problems.push(`${readme}: no Options row for \`${key}\` (src/type.ts ClientOptions)`);
    }
  }
}

if (problems.length) {
  console.error(`check-readme-options: ${problems.length} problem(s)`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(`check-readme-options: ${keys.length} options documented in both READMEs`);
