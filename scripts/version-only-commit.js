#!/usr/bin/env node
// Prints "true" when a commit's diff from its first parent only bumps the
// version of package.json / harmony/pushy/oh-package.json5 and edits the
// release notes under .github/releases/, "false" otherwise (the reason goes
// to stderr). Such a release commit builds the same native code as its
// parent, so the E2E workflows skip their jobs for it and publish.yml relies
// on the parent's native-required instead (see .github/actions/version-only).
//
// GitHub path filters only see file names; this looks at the diff itself, so
// any other change to either manifest (dependencies, `files`, codegenConfig,
// scripts) still runs the full native suite.
//
// Usage: node scripts/version-only-commit.js [rev]   (rev defaults to HEAD)
const { execFileSync } = require('child_process');

const MANIFESTS = ['package.json', 'harmony/pushy/oh-package.json5'];
const RELEASE_NOTES = /^\.github\/releases\/[^/]+$/;
// One `version` entry per line, key bare or quoted (JSON5), as both
// manifests are written; mirrors the regex in check-release-version.js.
const VERSION_LINE =
  /^\s*(?:"version"|'version'|version)\s*:\s*['"][^'"]+['"]\s*,?\s*$/;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function versionOnlyReason(rev = 'HEAD', cwd = process.cwd()) {
  let parent;
  try {
    parent = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^1`]).trim();
  } catch {
    return `${rev} has no parent in this clone`;
  }
  const files = git(cwd, ['diff', '--name-only', '--no-renames', parent, rev])
    .split('\n')
    .filter(Boolean);
  if (files.length === 0) {
    return `${rev} changes nothing`;
  }
  for (const file of files) {
    if (RELEASE_NOTES.test(file)) {
      continue;
    }
    if (!MANIFESTS.includes(file)) {
      return `${file} changed`;
    }
    const changed = git(cwd, [
      'diff',
      '-U0',
      '--no-color',
      parent,
      rev,
      '--',
      file,
    ])
      .split('\n')
      .filter((line) => /^[-+]/.test(line) && !/^(---|\+\+\+) /.test(line));
    const removed = changed.filter((line) => line[0] === '-');
    const added = changed.filter((line) => line[0] === '+');
    if (
      removed.length !== 1 ||
      added.length !== 1 ||
      !VERSION_LINE.test(removed[0].slice(1)) ||
      !VERSION_LINE.test(added[0].slice(1))
    ) {
      return `${file} changed beyond its version line`;
    }
  }
  return null;
}

module.exports = { versionOnlyReason };

if (require.main === module) {
  const rev = process.argv[2] || 'HEAD';
  const reason = versionOnlyReason(rev);
  console.error(
    reason
      ? `version-only-commit: no, ${reason}`
      : `version-only-commit: yes, ${rev} only bumps the version / release notes`
  );
  console.log(reason ? 'false' : 'true');
}
