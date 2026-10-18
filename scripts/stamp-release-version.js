#!/usr/bin/env node
// Releases are cut from the GitHub Release tag alone (vX.Y.Z on a green
// master commit, no version-bump commit), so the version is written into the
// package here, before the HAR build and npm publish:
// - package.json: the version npm publishes and the podspec reads.
// - harmony/pushy/oh-package.json5: the HAR's own version. Consumers'
//   oh-package-lock.json5 and diagnostics can only tell installs apart when it
//   equals the npm version (scripts/build-harmony-har.js syncs it from
//   package.json again before assembleHar).
const fs = require('fs');
const path = require('path');

const tag = process.env.RELEASE_VERSION || '';
const version = tag.replace(/^v/, '');
// semver: X.Y.Z with an optional prerelease (10.62.0-beta.1).
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  console.error(
    `stamp-release-version: release tag '${tag}' is not vX.Y.Z or vX.Y.Z-prerelease`
  );
  process.exit(1);
}

const root = path.join(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

const ohPackagePath = path.join(root, 'harmony/pushy/oh-package.json5');
const ohPackage = fs.readFileSync(ohPackagePath, 'utf8');
// JSON5 allows the key bare or quoted (syncOhPackageVersion in
// scripts/build-harmony-har.js matches the same shapes).
const versionLine =
  /^(\s*(?:"version"|'version'|version)\s*:\s*)(['"])([^'"]*)\2(\s*,?)/m;
if (!versionLine.test(ohPackage)) {
  console.error(
    'stamp-release-version: no version field in harmony/pushy/oh-package.json5'
  );
  process.exit(1);
}
fs.writeFileSync(
  ohPackagePath,
  ohPackage.replace(
    versionLine,
    (_, prefix, quote, __, suffix) => `${prefix}${quote}${version}${quote}${suffix}`
  )
);
console.log(
  `stamp-release-version: package.json and oh-package.json5 set to ${version} from ${tag}`
);
