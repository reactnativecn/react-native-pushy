import { describe, expect, test } from 'bun:test';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_SWITCH_VERSION_FAILED,
  getErrorMessage,
  type PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { evalHarmonyModule, source, stripComments } from './nativeSources';

// Harmony InstallRecord.ts is a thin binding over the shared completion
// record core (cpp/patch_core/install_record.h, replayed against
// tests/install-record-vectors.json by the C++ test). What is left to test
// here: the paths it builds, what it hands the NAPI module, the stable error
// codes it maps rejections to, and that every NAPI binding it relies on is
// exported by pushy.cpp.

interface InstallRecordModule {
  STAGING_SUFFIX: string;
  HARMONY_BUNDLE_FILE_NAME: string;
  stagingDirectoryFor(versionDir: string): string;
  sealInstallRecord(dir: string, hash: string, artifact: string): Promise<void>;
  promoteStaging(staging: string, version: string): Promise<void>;
  isInstallComplete(dir: string, hash: string): boolean;
  recordedBundleSha256(dir: string): string;
  verifyInstallForActivation(
    dir: string,
    hash: string,
    grandfathered: boolean
  ): Promise<void>;
}

function load(rejection?: string) {
  const calls: Array<[string, unknown[]]> = [];
  const call =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return result;
    };
  const settle =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      if (rejection !== undefined) {
        throw new Error(rejection);
      }
    };
  const NativePatchCore = {
    sealInstallRecord: settle('sealInstallRecord'),
    promoteStaging: settle('promoteStaging'),
    checkActivation: settle('checkActivation'),
    isInstallComplete: call('isInstallComplete', true),
    recordedBundleSha256: call('recordedBundleSha256', 'ab'),
  };
  const module = evalHarmonyModule(
    'InstallRecord.ts',
    `({ STAGING_SUFFIX, HARMONY_BUNDLE_FILE_NAME, stagingDirectoryFor,
       sealInstallRecord, promoteStaging,
       isInstallComplete, recordedBundleSha256, verifyInstallForActivation });`,
    {
      NativePatchCore,
      ERROR_DELTA_FAILED,
      ERROR_SWITCH_VERSION_FAILED,
      createPushyError,
      getErrorMessage,
    }
  ) as InstallRecordModule;
  return { module, calls };
}

const DIR = '/data/_update/abc';
const BUNDLE = 'bundle.harmony.js';

async function rejectionOf(promise: Promise<void>): Promise<PushyError> {
  try {
    await promise;
  } catch (e) {
    return e as PushyError;
  }
  throw new Error('expected a rejection');
}

describe('harmony install record paths', () => {
  const { module } = load();

  test('the staging directory is a sibling of the version directory', () => {
    expect(module.stagingDirectoryFor(DIR)).toBe(
      `${DIR}${module.STAGING_SUFFIX}`
    );
    expect(module.HARMONY_BUNDLE_FILE_NAME).toBe(BUNDLE);
  });
});

describe('harmony install record bindings', () => {
  test('presence and crash attribution are synchronous pass-throughs', () => {
    const { module, calls } = load();
    expect(module.isInstallComplete(DIR, 'abc')).toBe(true);
    expect(module.recordedBundleSha256(DIR)).toBe('ab');
    expect(calls).toEqual([
      ['isInstallComplete', [DIR, 'abc', BUNDLE]],
      ['recordedBundleSha256', [DIR]],
    ]);
  });

  test('seal, promote and activation hand the core the Harmony bundle name', async () => {
    const { module, calls } = load();
    await module.sealInstallRecord(`${DIR}.staging`, 'abc', 'ff');
    await module.promoteStaging(`${DIR}.staging`, DIR);
    await module.verifyInstallForActivation(DIR, 'abc', true);
    expect(calls).toEqual([
      ['sealInstallRecord', [`${DIR}.staging`, 'abc', BUNDLE, 'ff']],
      ['promoteStaging', [`${DIR}.staging`, DIR]],
      ['checkActivation', [DIR, 'abc', BUNDLE, true]],
    ]);
  });

  test('install failures are PATCH_FAILED with the core message', async () => {
    const { module } = load('Bundle version abc has no bundle digest.');
    for (const promise of [
      module.sealInstallRecord(`${DIR}.staging`, 'abc', ''),
      module.promoteStaging(`${DIR}.staging`, DIR),
    ]) {
      const error = await rejectionOf(promise);
      expect(error.code).toBe(ERROR_DELTA_FAILED);
      expect(error.message).toBe(
        `[${ERROR_DELTA_FAILED}] Bundle version abc has no bundle digest.`
      );
    }
  });

  test('activation failures are SWITCH_VERSION_FAILED with the core reason', async () => {
    const { module } = load('Bundle version abc completion record mismatch.');
    const error = await rejectionOf(
      module.verifyInstallForActivation(DIR, 'abc', false)
    );
    expect(error.code).toBe(ERROR_SWITCH_VERSION_FAILED);
    expect(error.message).toBe(
      `[${ERROR_SWITCH_VERSION_FAILED}] Bundle version abc completion record mismatch.`
    );
  });

  test('NativePatchCore declares exactly what pushy.cpp exports', () => {
    const typings = stripComments(
      source('harmony/pushy/src/main/ets/NativePatchCore.ts')
    );
    const body = typings.slice(
      typings.indexOf('interface NativePatchCoreBindings {'),
      typings.indexOf(
        '\n}\n',
        typings.indexOf('interface NativePatchCoreBindings {')
      )
    );
    const declared = [...body.matchAll(/^ {2}(\w+)\(/gm)]
      .map((m) => m[1])
      .sort();
    const exported = [
      ...source('harmony/pushy/src/main/cpp/pushy.cpp').matchAll(
        /ExportFunction\(env, exports, "(\w+)"/g
      ),
    ]
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual(exported);
    for (const name of [
      'isInstallComplete',
      'recordedBundleSha256',
      'sealInstallRecord',
      'promoteStaging',
      'checkActivation',
    ]) {
      expect(exported).toContain(name);
    }
  });
});
