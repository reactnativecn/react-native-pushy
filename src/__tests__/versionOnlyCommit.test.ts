import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { versionOnlyReason } from '../../scripts/version-only-commit';

// A commit that only bumps the manifest versions and adds release notes skips
// native E2E and is published on its parent's native-required, so anything
// else touching those manifests must not pass for one.
const pkg = (version: string, extra = '') =>
  `{\n  "name": "react-native-update",\n  "version": "${version}",${extra}\n  "main": "src/index.ts"\n}\n`;
const ohPkg = (version: string) =>
  `{\n  name: 'pushy',\n  version: '${version}',\n  dependencies: {},\n}\n`;

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const write = (files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
};
const commit = (files: Record<string, string>) => {
  write(files);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'commit');
};
const reason = () => versionOnlyReason('HEAD', repo);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'version-only-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  commit({
    'package.json': pkg('1.0.0'),
    'harmony/pushy/oh-package.json5': ohPkg('1.0.0'),
    'src/index.ts': 'export {};\n',
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('version-only-commit', () => {
  test('a release commit is version-only', () => {
    commit({
      'package.json': pkg('1.0.1'),
      'harmony/pushy/oh-package.json5': ohPkg('1.0.1'),
      '.github/releases/v1.0.1.md': '# v1.0.1\n',
    });
    expect(reason()).toBeNull();
  });

  test('release notes alone are version-only', () => {
    commit({ '.github/releases/v1.0.0.md': '# v1.0.0\n' });
    expect(reason()).toBeNull();
  });

  test('any other file is not', () => {
    commit({ 'package.json': pkg('1.0.1'), 'src/index.ts': 'export {}\n' });
    expect(reason()).toBe('src/index.ts changed');
  });

  test('nested paths under .github/releases are not release notes', () => {
    commit({ '.github/releases/x/action.yml': 'x\n' });
    expect(reason()).toBe('.github/releases/x/action.yml changed');
  });

  test('another manifest change next to the bump is not', () => {
    commit({ 'package.json': pkg('1.0.1', '\n  "files": ["src"],') });
    expect(reason()).toBe('package.json changed beyond its version line');
  });

  test('a manifest change without the bump is not', () => {
    commit({
      'harmony/pushy/oh-package.json5': ohPkg('1.0.0').replace(
        'dependencies: {}',
        "dependencies: { a: '1' }"
      ),
    });
    expect(reason()).toBe(
      'harmony/pushy/oh-package.json5 changed beyond its version line'
    );
  });

  test('an empty commit or a root commit is not', () => {
    commit({});
    expect(reason()).toBe('HEAD changes nothing');
    git('checkout', '-q', '--orphan', 'other');
    git('commit', '-q', '-m', 'root');
    expect(reason()).toBe('HEAD has no parent in this clone');
  });
});
