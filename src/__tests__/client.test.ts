import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  createClient,
  createJsonResponse,
  importFreshClient,
  mockCore,
  mockI18n,
  mockPlatform,
  restoreDevAfterEach,
} from './helpers';
import { realProjectModules } from './setup';

const originalErrorUtils = (globalThis as any).ErrorUtils;

// Module mocks and mock.restore() are handled globally in setup.ts.
restoreDevAfterEach();
afterEach(() => {
  if (originalErrorUtils === undefined) {
    delete (globalThis as any).ErrorUtils;
  } else {
    (globalThis as any).ErrorUtils = originalErrorUtils;
  }
});

const setupClientMocks = ({
  isFirstTime = false,
  markSuccess = mock(() => {}),
  reloadUpdate = mock(() => Promise.resolve()),
  setNeedUpdate = mock(() => Promise.resolve()),
  downloadPatchFromPpk = mock(() => Promise.resolve()),
  downloadPatchFromPackage = mock(() => Promise.resolve()),
  downloadFullUpdate = mock(() => Promise.resolve()),
  addProgressListener = mock(() => ({ remove: mock(() => {}) })),
  restartApp = mock(() => Promise.resolve()),
  // null simulates an older native module without the method (undefined would
  // just re-trigger this default).
  resetToPackagedBundle = mock(() => Promise.resolve()),
  // 原生上报的可消费 diff 轨道版本;0 模拟旧原生(不上报 diffV)
  supportedDiffVersion = 2,
  // 内嵌 bundle 的 sha256(core 层同步读预取值);'' 模拟未知
  getBundleHash = mock(() => ''),
  // undefined 模拟旧原生(无该方法,feature-detect 静默跳过)
  syncNativeConfig = undefined,
  getNativeCheckCache = undefined,
  markJsCheckCompleted = undefined,
  setLocalHashInfo = mock(() => {}),
  downloadAndInstallApk = mock(() => Promise.resolve()),
  platform = 'ios',
}: {
  isFirstTime?: boolean;
  markSuccess?: ReturnType<typeof mock>;
  reloadUpdate?: ReturnType<typeof mock>;
  setNeedUpdate?: ReturnType<typeof mock>;
  downloadPatchFromPpk?: ReturnType<typeof mock>;
  downloadPatchFromPackage?: ReturnType<typeof mock>;
  downloadFullUpdate?: ReturnType<typeof mock>;
  addProgressListener?: ReturnType<typeof mock>;
  restartApp?: ReturnType<typeof mock>;
  resetToPackagedBundle?: ReturnType<typeof mock> | null;
  supportedDiffVersion?: number;
  getBundleHash?: ReturnType<typeof mock>;
  syncNativeConfig?: ReturnType<typeof mock>;
  getNativeCheckCache?: ReturnType<typeof mock>;
  markJsCheckCompleted?: ReturnType<typeof mock>;
  setLocalHashInfo?: ReturnType<typeof mock>;
  downloadAndInstallApk?: ReturnType<typeof mock>;
  platform?: 'ios' | 'android';
} = {}) => {
  (globalThis as any).__DEV__ = false;

  mockPlatform({ OS: platform, Version: platform === 'ios' ? 17 : 30 });
  mockCore({
    PushyModule: {
      markSuccess,
      reloadUpdate,
      setNeedUpdate,
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
      downloadAndInstallApk,
      restartApp,
      resetToPackagedBundle,
      ...(syncNativeConfig ? { syncNativeConfig } : {}),
      ...(getNativeCheckCache ? { getNativeCheckCache } : {}),
      ...(markJsCheckCompleted ? { markJsCheckCompleted } : {}),
    },
    cInfo: { rnu: '10.0.0', rn: '0.73.0', os: platform, uuid: 'uuid' },
    isFirstTime,
    pushyNativeEventEmitter: {
      addListener: addProgressListener,
    },
    setLocalHashInfo,
    supportedDiffVersion,
    getBundleHash,
  });
  mockI18n();
};

describe('Pushy server config', () => {
  test('uses preset main endpoints directly as configured endpoints', async () => {
    setupClientMocks();

    const { client } = await createClient();

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://update.react-native.cn/api',
      'https://update.reactnative.cn/api',
    ]);
  });

  test('dedupes remote endpoints (the fallback drops configured ones)', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse([
        'https://update.react-native.cn/api',
        'https://edge-a.example.com',
        'https://edge-a.example.com',
        'https://update.reactnative.cn/api',
        'https://edge-b.example.com',
      ])
    );

    const { client } = await createClient();

    expect(await client.getRemoteEndpoints()).toEqual([
      'https://update.react-native.cn/api',
      'https://edge-a.example.com',
      'https://update.reactnative.cn/api',
      'https://edge-b.example.com',
    ]);
  });

  test('clones custom server config when setOptions overrides server', async () => {
    setupClientMocks();

    const { client } = await createClient();
    const server = {
      main: ['https://a.example.com', 'https://b.example.com'],
      queryUrls: ['https://q.example.com'],
    };

    client.setOptions({ server });
    server.main.push('https://c.example.com');
    server.queryUrls.push('https://r.example.com');

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(client.options.server?.queryUrls).toEqual(['https://q.example.com']);
  });

  test('report delivers to a logger provided later via setOptions (JS-20)', async () => {
    setupClientMocks();
    const logger = mock(() => {});

    const { client } = await createClient();

    const reportPromise = (client as any).report({ type: 'markSuccess' });
    expect(logger).not.toHaveBeenCalled();

    client.setOptions({ logger });
    await reportPromise;

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'markSuccess' })
    );
  });

  test('errors and invalid-update reports go through the client report', async () => {
    setupClientMocks();
    const { client } = await createClient();
    const report = spyOn(client as any, 'report').mockImplementation(
      async () => {}
    );

    (client as any).emitError(new Error('offline'), 'errorChecking');
    client.reportInvalidUpdateOnce('noArtifact', 'h2');

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'errorChecking', message: 'offline' })
    );
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorUpdate',
        data: { newVersion: 'h2' },
      })
    );
  });

  test('calls afterCheckUpdate with skipped when beforeCheckUpdate returns false', async () => {
    setupClientMocks();
    const beforeCheckUpdate = mock(() => false);
    const afterCheckUpdate = mock(() => {});

    const { client } = await createClient({
      beforeCheckUpdate,
      afterCheckUpdate,
    });

    expect(await client.checkUpdate()).toBeUndefined();
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'skipped',
    });
  });

  test('calls afterCheckUpdate with completed and result when check succeeds', async () => {
    setupClientMocks();
    const afterCheckUpdate = mock(() => {});
    const checkResult = {
      update: true as const,
      name: '1.0.1',
      hash: 'next-hash',
      description: 'bugfix',
    };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(checkResult)
    );

    const { client } = await createClient({
      afterCheckUpdate,
    });

    expect(await client.checkUpdate()).toEqual(checkResult);
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'completed',
      result: checkResult,
    });
  });

  test('resolves the gray rollout for direct checkUpdate callers', async () => {
    setupClientMocks();
    const afterCheckUpdate = mock(() => {});
    const { client } = await createClient({ afterCheckUpdate });
    const rootFor = (rollout: number) => ({
      update: true as const,
      name: 'root',
      hash: 'root-hash',
      full: 'root.ppk',
      paths: ['https://cdn.example.com'],
      expVersion: {
        name: 'gray',
        hash: 'gray-hash',
        full: 'gray.ppk',
        config: {
          rollout: { [client.getEffectivePackageVersion()]: rollout },
        },
      },
    });

    // Every device is in a 100% rollout: the candidate replaces the root
    // release (keeping the root's CDN paths), and expVersion is gone.
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(rootFor(100))
    );
    const inRollout = await client.checkUpdate({ round: 1 });
    expect(inRollout).toMatchObject({
      update: true,
      name: 'gray',
      hash: 'gray-hash',
      paths: ['https://cdn.example.com'],
    });
    expect(inRollout).not.toHaveProperty('expVersion');
    expect(afterCheckUpdate).toHaveBeenLastCalledWith({
      status: 'completed',
      result: inRollout,
    });

    // No device is in a 0% rollout: the root release applies.
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(rootFor(0))
    );
    const outOfRollout = await client.checkUpdate({ round: 2 });
    expect(outOfRollout).toMatchObject({ update: true, hash: 'root-hash' });
    expect(outOfRollout).not.toHaveProperty('expVersion');
  });

  test('reports the native diff track version as diffV in the check body', async () => {
    setupClientMocks({ supportedDiffVersion: 2 });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { client } = await createClient();
    await client.checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body.diffV).toBe(2);
  });

  test('omits diffV when the native module reports no diff track support', async () => {
    setupClientMocks({ supportedDiffVersion: 0 });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { client } = await createClient();
    await client.checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body).not.toHaveProperty('diffV');
  });

  test('reports the embedded bundle hash as bundleHash in the check body', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'a'.repeat(64)) });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { client } = await createClient();
    await client.checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body.bundleHash).toBe('a'.repeat(64));
  });

  test('omits bundleHash while the hash is unknown', async () => {
    // '' covers "not computed yet" (first launch), debug builds, older native
    // modules and missing embedded bundles alike; the check proceeds without
    // the field and the server falls back to the buildTime heuristic.
    setupClientMocks({ getBundleHash: mock(() => '') });
    const fetchMock = mock(async () => createJsonResponse({ update: false }));
    (globalThis as any).fetch = fetchMock;

    const { client } = await createClient();
    await client.checkUpdate();

    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body);
    expect(body).not.toHaveProperty('bundleHash');
  });

  test('surfaces an unknownBundle verdict through the logger as bundleMismatch', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'b'.repeat(64)) });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true, bundleStatus: 'unknownBundle' })
    );

    const events: any[] = [];
    const { client } = await createClient({
      logger: (event: any) => events.push(event),
    });
    const result = await client.checkUpdate();

    expect(result?.bundleStatus).toBe('unknownBundle');
    const mismatch = events.find((event) => event.type === 'bundleMismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch.data.bundleHash).toBe('b'.repeat(64));
  });

  test('matched bundleStatus stays silent', async () => {
    setupClientMocks({ getBundleHash: mock(() => 'c'.repeat(64)) });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true, bundleStatus: 'matched' })
    );

    const events: any[] = [];
    const { client } = await createClient({
      logger: (event: any) => events.push(event),
    });
    await client.checkUpdate();

    expect(events.some((event) => event.type === 'bundleMismatch')).toBe(false);
  });

  test('calls afterCheckUpdate with error before rethrowing when throwError is enabled', async () => {
    setupClientMocks();
    const afterCheckUpdate = mock(() => {});
    const fetchError = new Error('boom');
    (globalThis as any).fetch = mock(async () => {
      throw fetchError;
    });

    const { client } = await createClient({
      throwError: true,
      afterCheckUpdate,
    });

    await expect(client.checkUpdate()).rejects.toThrow('boom');
    expect(afterCheckUpdate).toHaveBeenCalledWith({
      status: 'error',
      error: fetchError,
    });
  });

  test('skips downloading when update hash is already current', async () => {
    const downloadPatchFromPpk = mock(() => Promise.resolve());
    const downloadPatchFromPackage = mock(() => Promise.resolve());
    const downloadFullUpdate = mock(() => Promise.resolve());
    const logger = mock(() => {});
    setupClientMocks({
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    });

    const { client } = await createClient({
      logger,
    });

    await expect(
      client.downloadUpdate({
        update: true,
        hash: 'hash',
        full: 'hash',
        paths: ['cdn.example.com'],
      })
    ).resolves.toBeUndefined();

    expect(downloadPatchFromPpk).not.toHaveBeenCalled();
    expect(downloadPatchFromPackage).not.toHaveBeenCalled();
    expect(downloadFullUpdate).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'downloading',
      })
    );
  });

  test('waits for native markSuccess before logging success', async () => {
    let resolveNativeMarkSuccess = () => {};
    const nativeMarkSuccess = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveNativeMarkSuccess = resolve;
        })
    );
    const logger = mock(() => {});
    setupClientMocks({
      isFirstTime: true,
      markSuccess: nativeMarkSuccess,
    });

    const { client, sharedState } = await createClient({
      logger,
    });

    const markPromise = client.markSuccess();
    expect(nativeMarkSuccess).toHaveBeenCalledTimes(1);
    expect(sharedState.marked).toBe(false);
    expect(logger).not.toHaveBeenCalled();

    resolveNativeMarkSuccess();
    await markPromise;

    expect(sharedState.marked).toBe(true);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'markSuccess',
      })
    );
  });

  test('concurrent markSuccess calls share one native call and one report', async () => {
    let resolveNative = () => {};
    const nativeMarkSuccess = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveNative = resolve;
        })
    );
    const logger = mock(() => {});
    setupClientMocks({ isFirstTime: true, markSuccess: nativeMarkSuccess });
    const { client, sharedState } = await createClient({ logger });

    const first = client.markSuccess();
    const second = client.markSuccess();
    resolveNative();
    await Promise.all([first, second]);
    await client.markSuccess();

    expect(nativeMarkSuccess).toHaveBeenCalledTimes(1);
    expect(sharedState.marked).toBe(true);
    expect(
      logger.mock.calls.filter(([event]: any[]) => event.type === 'markSuccess')
    ).toHaveLength(1);
  });

  test('a failed markSuccess can be retried', async () => {
    let calls = 0;
    const nativeMarkSuccess = mock(() =>
      ++calls === 1 ? Promise.reject(Error('busy')) : Promise.resolve()
    );
    setupClientMocks({ isFirstTime: true, markSuccess: nativeMarkSuccess });
    const { client, sharedState } = await createClient();
    const errors: any[] = [];
    client.onError((e: any) => {
      errors.push(e);
    });

    const results = await Promise.allSettled([
      client.markSuccess(),
      client.markSuccess(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    // One failure, one report — not one per caller.
    expect(errors).toHaveLength(1);
    expect(sharedState.marked).toBe(false);

    await client.markSuccess();
    expect(nativeMarkSuccess).toHaveBeenCalledTimes(2);
    expect(sharedState.marked).toBe(true);
  });

  test('waits for beforeReload before switching version', async () => {
    const calls: string[] = [];
    const reloadUpdate = mock(() => {
      calls.push('reloadUpdate');
      return Promise.resolve();
    });
    const beforeReload = mock(async (context: any) => {
      calls.push('beforeReload');
      expect(context).toEqual({
        type: 'switchVersion',
        hash: 'next-hash',
      });
    });
    setupClientMocks({ reloadUpdate });

    const { client, sharedState } = await createClient({
      beforeReload,
    });
    sharedState.downloadedHash = 'next-hash';

    await client.switchVersion('next-hash');

    expect(calls).toEqual(['beforeReload', 'reloadUpdate']);
    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(reloadUpdate).toHaveBeenCalledWith({ hash: 'next-hash' });
  });

  test('skips switching version when beforeReload returns false', async () => {
    const reloadUpdate = mock(() => Promise.resolve());
    const beforeReload = mock(() => false);
    setupClientMocks({ reloadUpdate });

    const { client, sharedState } = await createClient({
      beforeReload,
    });
    sharedState.downloadedHash = 'next-hash';

    await client.switchVersion('next-hash');

    expect(beforeReload).toHaveBeenCalledTimes(1);
    expect(reloadUpdate).not.toHaveBeenCalled();
    expect(sharedState.applyingUpdate).toBe(false);
  });

  test('calls beforeReload before restartApp', async () => {
    const calls: string[] = [];
    const restartApp = mock(() => {
      calls.push('restartApp');
      return Promise.resolve();
    });
    const beforeReload = mock(async (context: any) => {
      calls.push('beforeReload');
      expect(context).toEqual({
        type: 'restartApp',
      });
    });
    setupClientMocks({ restartApp });

    const { client } = await createClient({
      beforeReload,
    });

    await client.restartApp();

    expect(calls).toEqual(['beforeReload', 'restartApp']);
    expect(restartApp).toHaveBeenCalled();
  });
});

describe('JS exception reporting', () => {
  test('reports the current OTA identity and deduplicates the same Error object', async () => {
    setupClientMocks();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as any).fetch = mock(
      async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return createJsonResponse({ ok: 1 });
      }
    );

    const { client } = await createClient();
    const error = Object.assign(new Error('boom'), {
      name: 'TypeError',
      stack: 'TypeError: boom\n at index.bundlejs:12:34',
    });
    client.captureException(error, {
      fatal: true,
      componentStack: 'at Screen',
      extra: { screen: 'order', retry: 2 },
    });
    client.captureException(error);
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      'https://update.react-native.cn/api/report/demo-app'
    );
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      type: 'js_exception',
      hash: 'hash',
      packageVersion: '1.0.0',
      cInfo: {
        rnu: '10.0.0',
        rn: '0.73.0',
        os: 'ios',
        uuid: 'uuid',
      },
      error: {
        name: 'TypeError',
        message: 'boom',
        stack: error.stack,
        fatal: true,
        componentStack: 'at Screen',
        extra: { screen: 'order', retry: 2 },
      },
    });
  });

  test('global reporting is enabled by default, chains, and restores ErrorUtils', async () => {
    setupClientMocks();
    const fetch = mock(async () => createJsonResponse({ ok: 1 }));
    (globalThis as any).fetch = fetch;
    const previous = mock((_error: unknown, _fatal?: boolean) => {});
    let current: (error: unknown, fatal?: boolean) => void = previous;
    (globalThis as any).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: typeof current) => {
        current = handler;
      },
    };

    const { client } = await createClient();
    expect(current).not.toBe(previous);
    const cleanup = client.enableErrorReporting();
    const error = new Error('fatal');
    current(error, true);
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(error, true);
    cleanup();
    expect(current).toBe(previous);
  });

  test('disableErrorReporting explicitly opts out and can be toggled', async () => {
    setupClientMocks();
    const fetch = mock(async () => createJsonResponse({ ok: 1 }));
    (globalThis as any).fetch = fetch;
    const previous = mock((_error: unknown, _fatal?: boolean) => {});
    let current: (error: unknown, fatal?: boolean) => void = previous;
    (globalThis as any).ErrorUtils = {
      getGlobalHandler: () => current,
      setGlobalHandler: (handler: typeof current) => {
        current = handler;
      },
    };

    const { client } = await createClient({
      disableErrorReporting: true,
    });
    expect(current).toBe(previous);
    client.captureException(new Error('ignored'));
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();

    client.setOptions({ disableErrorReporting: false });
    expect(current).not.toBe(previous);
    current(new Error('reported'), false);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);

    client.setOptions({ disableErrorReporting: true });
    expect(current).toBe(previous);
  });

  test('disableTelemetry also disables exception transport', async () => {
    setupClientMocks();
    const fetch = mock(async () => createJsonResponse({ ok: 1 }));
    (globalThis as any).fetch = fetch;
    const { client } = await createClient({ disableTelemetry: true });
    client.captureException(new Error('ignored'));
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('error pipeline (onError + stable codes, EH-1/EH-2/EH-3)', () => {
  test('check failure emits a coded error to onError listeners without throwing (throwError:false)', async () => {
    setupClientMocks();
    const logger = mock(() => {});
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });

    const { client } = await createClient({ logger });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    // Default throwError:false — resolves undefined instead of throwing.
    expect(await client.checkUpdate()).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorChecking');
    expect(seen[0].e.code).toBe('CHECK_FAILED');
    expect(seen[0].e.message).toBe('offline');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorChecking',
        data: expect.objectContaining({ code: 'CHECK_FAILED' }),
      })
    );
  });

  test('onError unsubscribe stops delivery', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });

    const { client } = await createClient();
    const listener = mock(() => {});
    const unsubscribe = client.onError(listener);
    unsubscribe();

    await client.checkUpdate();
    expect(listener).not.toHaveBeenCalled();
  });

  test('switchVersion failure is reported as errorSwitchVersion and rethrown (EH-3)', async () => {
    const reloadUpdate = mock(() => Promise.reject(Error('bundle missing')));
    const logger = mock(() => {});
    setupClientMocks({ reloadUpdate });

    const { client, sharedState } = await createClient({ logger });
    sharedState.downloadedHash = 'next-hash';
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'bundle missing'
    );

    expect(sharedState.applyingUpdate).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorSwitchVersion');
    expect(seen[0].e.code).toBe('SWITCH_VERSION_FAILED');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorSwitchVersion',
        data: expect.objectContaining({
          code: 'SWITCH_VERSION_FAILED',
          newVersion: 'next-hash',
        }),
      })
    );
  });

  test('a native-provided rejection code is preserved, not overwritten by the JS fallback (EH-5)', async () => {
    // Native modules reject with stable codes from cpp/patch_core/error_codes.h
    // (e.g. INVALID_OPTIONS); toUpdateError must keep them instead of stamping
    // the JS-layer fallback code on top.
    const nativeError: any = Error('empty hash');
    nativeError.code = 'INVALID_OPTIONS';
    const reloadUpdate = mock(() => Promise.reject(nativeError));
    setupClientMocks({ reloadUpdate });

    const { client, sharedState } = await createClient();
    sharedState.downloadedHash = 'next-hash';
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'empty hash'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].e.code).toBe('INVALID_OPTIONS');
  });

  test('a beforeReload hook throw gets USER_HOOK_ERROR, distinct from pipeline failures (JS2-3)', async () => {
    setupClientMocks();
    const { Pushy, sharedState } = await importFreshClient();
    sharedState.downloadedHash = 'next-hash';
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload: () => {
        throw new Error('hook exploded');
      },
    });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'hook exploded'
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorSwitchVersion');
    // Distinct code: telemetry excludes USER_HOOK_ERROR from server-side
    // patch-health stats (a hook bug is not a bad patch).
    expect(seen[0].e.code).toBe('USER_HOOK_ERROR');
    expect(sharedState.applyingUpdate).toBe(false);
  });

  test('an onError listener retrying switchVersion after a beforeReload throw is not ignored', async () => {
    const reloadUpdate = mock(() => Promise.resolve());
    setupClientMocks({ reloadUpdate });
    const { Pushy, sharedState } = await importFreshClient();
    sharedState.downloadedHash = 'next-hash';
    let hookCalls = 0;
    const client = new Pushy({
      appKey: 'demo-app',
      beforeReload: () => {
        hookCalls += 1;
        if (hookCalls === 1) {
          throw new Error('hook exploded');
        }
        return true;
      },
    });
    let retry: Promise<boolean> | undefined;
    client.onError(() => {
      // Synchronous retry: applyingUpdate must already be released.
      retry ??= client.switchVersion('next-hash');
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'hook exploded'
    );

    expect(retry).toBeDefined();
    expect(await retry).toBe(true);
    expect(hookCalls).toBe(2);
    expect(reloadUpdate).toHaveBeenCalledTimes(1);
  });

  test('concurrent checkUpdate reusing a failing in-flight check keeps its contracts (JS2-1)', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });
    const { Pushy } = await importFreshClient();
    const states: any[] = [];
    const client = new Pushy({
      appKey: 'demo-app',
      afterCheckUpdate: (state: any) => {
        states.push(state);
      },
    });

    // The second call starts inside the 5s window and awaits the first
    // call's in-flight promise (the cache path). Before the fix it rejected
    // raw, bypassing throwError:false and afterCheckUpdate entirely.
    const first = client.checkUpdate();
    const second = client.checkUpdate();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();

    // "Every check ends with a notification" — both calls, both as errors.
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.status === 'error')).toBe(true);
  });

  test('apk download failure keeps the native error and reports its message (EH-4)', async () => {
    const downloadAndInstallApk = mock(() =>
      Promise.reject(Error('disk full'))
    );
    const logger = mock(() => {});
    setupClientMocks({
      platform: 'android',
      downloadAndInstallApk: downloadAndInstallApk,
    });

    const { client } = await createClient({ logger });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await client.downloadAndInstallApk('https://example.com/app.apk');

    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorDownloadAndInstallApk');
    expect(seen[0].e.code).toBe('APK_DOWNLOAD_FAILED');
    // The original native error must not be discarded anymore.
    expect(seen[0].e.message).toBe('disk full');
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorDownloadAndInstallApk',
        data: expect.objectContaining({
          code: 'APK_DOWNLOAD_FAILED',
          message: 'disk full',
        }),
      })
    );
  });
});

describe('switchVersion operation ownership', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  test('a queued stale watchdog cannot clear or report for a newer switch', async () => {
    const callbacks = new Map<number, () => void>();
    const active = new Set<number>();
    let nextTimer = 0;
    globalThis.setTimeout = ((callback: () => void) => {
      const id = ++nextTimer;
      callbacks.set(id, callback);
      active.add(id);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      active.delete(Number(id));
    }) as unknown as typeof clearTimeout;

    setupClientMocks({ reloadUpdate: mock(() => Promise.resolve()) });
    const logger = mock((_event: any) => {});
    const { client, sharedState } = await createClient({
      logger,
      disableTelemetry: true,
      disableErrorReporting: true,
    });

    const onlyTimer = () => {
      const timer = active.values().next().value;
      if (typeof timer !== 'number') {
        throw new Error('expected one active reload watchdog');
      }
      return timer;
    };

    sharedState.downloadedHash = 'version-a';
    expect(await client.switchVersion('version-a')).toBe(true);
    const oldCallback = callbacks.get(onlyTimer())!;

    expect(await client.resetToPackagedBundle()).toBe(true);
    sharedState.downloadedHash = 'version-b';
    expect(await client.switchVersion('version-b')).toBe(true);
    const currentTimer = onlyTimer();

    oldCallback(); // simulate a callback already queued before clearTimeout
    expect(sharedState.applyingUpdate).toBe(true);
    expect(
      logger.mock.calls.some(([event]) => event.data?.code === 'RESTART_FAILED')
    ).toBe(false);

    callbacks.get(currentTimer)!();
    expect(sharedState.applyingUpdate).toBe(false);
    expect(
      logger.mock.calls.some(
        ([event]) =>
          event.data?.code === 'RESTART_FAILED' &&
          event.data?.newVersion === 'version-b'
      )
    ).toBe(true);
  });

  test('a superseded native rejection cannot clear a newer switch', async () => {
    globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    const calls: Array<{
      resolve: () => void;
      reject: (reason: unknown) => void;
    }> = [];
    const reloadUpdate = mock(
      () =>
        new Promise<void>((resolve, reject) => {
          calls.push({ resolve, reject });
        })
    );
    setupClientMocks({ reloadUpdate });
    const { client, sharedState } = await createClient({
      disableTelemetry: true,
      disableErrorReporting: true,
    });

    sharedState.downloadedHash = 'version-a';
    const first = client.switchVersion('version-a');
    await Promise.resolve();
    expect(await client.resetToPackagedBundle()).toBe(true);

    sharedState.downloadedHash = 'version-b';
    const second = client.switchVersion('version-b');
    await Promise.resolve();

    calls[0]!.reject(new Error('old reload failed'));
    await expect(first).rejects.toThrow('old reload failed');
    expect(sharedState.applyingUpdate).toBe(true);

    calls[1]!.resolve();
    expect(await second).toBe(true);
    expect(sharedState.applyingUpdate).toBe(true);
  });
});

describe('downloadUpdate fallback chain', () => {
  const realSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const setupDownloadMocks = ({
    downloadPatchFromPpk = mock(() => Promise.resolve()),
    downloadPatchFromPackage = mock(() => Promise.resolve()),
    downloadFullUpdate = mock(() => Promise.resolve()),
    addProgressListener = mock(() => ({ remove: mock(() => {}) })),
    setLocalHashInfo = mock(() => {}),
    fetchWithTimeout = mock(() => Promise.resolve()),
    testUrls = mock((urls?: string[]) => Promise.resolve(urls?.[0] || null)),
  }: {
    downloadPatchFromPpk?: ReturnType<typeof mock>;
    downloadPatchFromPackage?: ReturnType<typeof mock>;
    downloadFullUpdate?: ReturnType<typeof mock>;
    addProgressListener?: ReturnType<typeof mock>;
    setLocalHashInfo?: ReturnType<typeof mock>;
    fetchWithTimeout?: ReturnType<typeof mock>;
    testUrls?: ReturnType<typeof mock>;
  } = {}) => {
    setupClientMocks({
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
      addProgressListener,
      setLocalHashInfo,
    });

    // Override setTimeout to skip real backoff delays in retry tests
    globalThis.setTimeout = ((fn: (...args: any[]) => void, _ms?: number) =>
      realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

    // Mock testUrls to return urls directly (skip actual HEAD ping)
    mock.module('../utils', () => ({
      ...realProjectModules['../utils'],
      assertWeb: () => true,
      computeProgress: (received: number, total: number) =>
        total > 0
          ? Math.min(100, Math.max(0, Math.floor((received / total) * 100)))
          : 0,
      DEFAULT_FETCH_TIMEOUT_MS: 5000,
      fetchWithTimeout,
      info: mock(() => {}),
      log: mock(() => {}),
      noop: () => {},
      promiseAny: mock(() => Promise.resolve()),
      testUrls,
    }));

    return {
      testUrls,
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
      fetchWithTimeout,
    };
  };

  // The telemetry POSTs a download sent, as { type, detail } pairs.
  const serverReports = (fetchWithTimeout: ReturnType<typeof mock>) =>
    fetchWithTimeout.mock.calls
      .filter(([url]: any[]) => String(url).includes('/report/'))
      .map(([, init]: any[]): { type: string; detail?: string } => {
        const { type, detail } = JSON.parse(String(init.body));
        return { type, detail };
      });

  const updateInfo = {
    update: true as const,
    hash: 'new-hash',
    diff: 'diff.ppk',
    pdiff: 'pdiff.ppk',
    full: 'full.ppk',
    paths: ['https://cdn.example.com'],
    name: 'v2.0',
    description: 'test update',
  };

  test('uses diff when available', async () => {
    const { downloadPatchFromPpk } = setupDownloadMocks();
    const { client } = await createClient();

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
  });

  const twoMirrors = {
    ...updateInfo,
    paths: ['https://cdn-a.example.com', 'https://cdn-b.example.com'],
  };

  test('a mirror that fails mid-download is followed by the next mirror of the same artifact', async () => {
    let attempts = 0;
    const downloadPatchFromPpk = mock(
      ({ updateUrl }: { updateUrl: string }) => {
        attempts++;
        if (attempts === 1) {
          // HEAD "won" for cdn-a, but the real GET died mid-stream.
          const err: any = new Error('stream reset');
          err.code = 'DOWNLOAD_FAILED';
          return Promise.reject(err);
        }
        expect(updateUrl).toBe('https://cdn-b.example.com/diff.ppk');
        return Promise.resolve();
      }
    );
    const { downloadPatchFromPackage, downloadFullUpdate } = setupDownloadMocks(
      { downloadPatchFromPpk }
    );
    const { client } = await createClient({ maxRetries: 0 });

    expect(await client.downloadUpdate(twoMirrors)).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(2);
    expect(downloadPatchFromPpk.mock.calls[0][0].updateUrl).toBe(
      'https://cdn-a.example.com/diff.ppk'
    );
    // The strategy was rescued by its second mirror: no fallback to pdiff/full.
    expect(downloadPatchFromPackage).not.toHaveBeenCalled();
    expect(downloadFullUpdate).not.toHaveBeenCalled();
  });

  test('an unapplicable patch is not re-downloaded from other mirrors', async () => {
    const downloadPatchFromPpk = mock(() => {
      const err: any = new Error('hpatch failed');
      err.code = 'PATCH_FAILED';
      return Promise.reject(err);
    });
    const { downloadPatchFromPackage } = setupDownloadMocks({
      downloadPatchFromPpk,
    });
    const { client } = await createClient({ maxRetries: 0 });

    expect(await client.downloadUpdate(twoMirrors)).toBe('new-hash');
    // Same bytes on every mirror: one attempt, then straight to pdiff.
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
  });

  test('a throwing progress subscriber does not block other subscribers or the download', async () => {
    let listener: ((event: any) => void) | undefined;
    const addProgressListener = mock((_name: string, cb: any) => {
      listener = cb;
      return { remove: mock(() => {}) };
    });
    const downloadPatchFromPpk = mock(async () => {
      listener?.({ hash: 'new-hash', received: 50, total: 100 });
    });
    setupDownloadMocks({ downloadPatchFromPpk, addProgressListener });
    const { client } = await createClient({ maxRetries: 0 });

    const seen: number[] = [];
    const first = client.downloadUpdate(updateInfo, () => {
      throw new Error('subscriber bug');
    });
    // Joins the in-flight download and registers a second subscriber.
    const second = client.downloadUpdate(updateInfo, (data: any) => {
      seen.push(data.progress);
    });

    expect(await first).toBe('new-hash');
    expect(await second).toBe('new-hash');
    expect(seen).toEqual([50]);
  });

  test('a version is not "downloaded" until its hash info is persisted', async () => {
    const setLocalHashInfo = mock(() => Promise.reject(Error('commit failed')));
    setupDownloadMocks({ setLocalHashInfo });
    const { client, sharedState } = await createClient({ maxRetries: 0 });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'commit failed'
    );
    expect(sharedState.downloadedHash).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorUpdate');
    expect(seen[0].e.code).toBe('FILE_OPERATION_FAILED');
  });

  test('reports a release response with no downloadable artifact', async () => {
    const {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    } = setupDownloadMocks();
    const logger = mock(() => {});
    const { client } = await createClient({
      logger,
      disableTelemetry: true,
    });

    expect(
      await client.downloadUpdate({ ...updateInfo, paths: [] })
    ).toBeUndefined();
    expect(
      await client.downloadUpdate({ ...updateInfo, paths: [] })
    ).toBeUndefined();
    await Promise.resolve();

    expect(downloadPatchFromPpk).not.toHaveBeenCalled();
    expect(downloadPatchFromPackage).not.toHaveBeenCalled();
    expect(downloadFullUpdate).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorUpdate',
        data: expect.objectContaining({
          newVersion: 'new-hash',
          message: 'update response contains no downloadable artifact',
        }),
      })
    );
    expect(logger).toHaveBeenCalledTimes(1);
  });

  test('adds computed progress to download progress callbacks', async () => {
    let progressListener:
      | ((data: { hash: string; received: number; total: number }) => void)
      | undefined;
    const addProgressListener = mock(
      (_event: string, listener: typeof progressListener) => {
        progressListener = listener;
        return { remove: mock(() => {}) };
      }
    );
    const onDownloadProgress = mock(() => {});
    setupDownloadMocks({
      addProgressListener,
      downloadPatchFromPpk: mock(async () => {
        progressListener?.({
          hash: 'new-hash',
          received: 1200,
          total: 1000,
        });
      }),
    });
    const { client } = await createClient();

    await client.downloadUpdate(updateInfo, onDownloadProgress);

    expect(onDownloadProgress).toHaveBeenCalledWith({
      hash: 'new-hash',
      received: 1200,
      total: 1000,
      progress: 100,
    });
  });

  test('falls back to pdiff when diff fails', async () => {
    const { downloadPatchFromPpk, downloadPatchFromPackage } =
      setupDownloadMocks({
        downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      });
    const { client } = await createClient();

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
  });

  test('falls back to full when diff and pdiff fail', async () => {
    const {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
    });
    const { client } = await createClient();

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
  });

  test('throws when all download methods fail', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { client } = await createClient({ maxRetries: 0 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed'
    );
  });

  test('treats negative maxRetries as zero retries', async () => {
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { client } = await createClient({ maxRetries: -1 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed'
    );
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
  });

  test('retries download when maxRetries is set', async () => {
    let callCount = 0;
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(Error('full fail attempt 1'));
        }
        return Promise.resolve();
      }),
    });
    const { client } = await createClient({ maxRetries: 2 });

    const hash = await client.downloadUpdate(updateInfo);

    expect(hash).toBe('new-hash');
    expect(downloadFullUpdate).toHaveBeenCalledTimes(2);
  });

  test('mirrors are ranked once per strategy across retries; a failed winner is demoted', async () => {
    const fullUrls: string[] = [];
    let fullCalls = 0;
    const { testUrls } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(({ updateUrl }: { updateUrl: string }) => {
        fullUrls.push(updateUrl);
        // Attempt 0 fails on both mirrors; attempt 1 succeeds on its first.
        return ++fullCalls <= 2
          ? Promise.reject(Error('full fail'))
          : Promise.resolve();
      }),
    });
    const { client } = await createClient({ maxRetries: 3 });

    expect(await client.downloadUpdate(twoMirrors)).toBe('new-hash');
    // diff, pdiff, full: one HEAD race each, not one per attempt.
    expect(testUrls).toHaveBeenCalledTimes(3);
    expect(fullUrls).toEqual([
      'https://cdn-a.example.com/full.ppk',
      'https://cdn-b.example.com/full.ppk',
      // The HEAD winner failed: the retry starts from the other mirror.
      'https://cdn-b.example.com/full.ppk',
    ]);
  });

  test('defaults to 3 retries when maxRetries is not set', async () => {
    const { downloadFullUpdate } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { client } = await createClient();

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow();
    // 1 initial + 3 retries = 4 calls
    expect(downloadFullUpdate).toHaveBeenCalledTimes(4);
  });

  test('exhausts retries and throws on persistent failure', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { client } = await createClient({ maxRetries: 2 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow(
      'error_full_patch_failed'
    );
  });

  test('all-strategies failure carries the DOWNLOAD_FAILED code (EH-1)', async () => {
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(Error('full fail'))),
    });
    const { client } = await createClient({ maxRetries: 0 });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    const err: any = await client
      .downloadUpdate(updateInfo)
      .catch((e: any) => e);

    expect(err.code).toBe('DOWNLOAD_FAILED');
    expect(seen).toHaveLength(1);
    expect(seen[0].eventType).toBe('errorUpdate');
    expect(seen[0].e).toBe(err);
  });

  test('a native PATCH_FAILED rejection survives to the thrown error (JS2-2)', async () => {
    // Before the fix, the strategy loop re-created a plain Error from the
    // i18n message, dropping the native code — telemetry then classified
    // every failure as download_fail and patch_fail never fired.
    const patchError: any = Error('hpatch failed');
    patchError.code = 'PATCH_FAILED';
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(Error('diff fail'))),
      downloadPatchFromPackage: mock(() => Promise.reject(Error('pdiff fail'))),
      downloadFullUpdate: mock(() => Promise.reject(patchError)),
    });
    const { client } = await createClient({ maxRetries: 0 });
    const seen: any[] = [];
    client.onError((e: any, eventType: string) => {
      seen.push({ e, eventType });
    });

    const err: any = await client
      .downloadUpdate(updateInfo)
      .catch((e: any) => e);

    expect(err.code).toBe('PATCH_FAILED');
    expect(err.cause).toBe(patchError);
    expect(seen[0].e.code).toBe('PATCH_FAILED');
  });

  test('deduplicates concurrent downloads of the same hash (JS-8)', async () => {
    // A slow native download keeps the first call in-flight while the second
    // starts, so the dedup must reuse the same promise instead of triggering a
    // second native download.
    let resolveDownload: (() => void) | undefined;
    const downloadFullUpdate = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveDownload = resolve;
        })
    );
    setupDownloadMocks({ downloadFullUpdate });
    // Only a full URL so the full strategy is the one exercised.
    const fullOnlyInfo = {
      update: true as const,
      hash: 'new-hash',
      full: 'full.ppk',
      paths: ['https://cdn.example.com'],
      name: 'v2.0',
      description: 'test update',
    };
    // No onDownloadProgress passed — old code only deduped when a progress
    // handler was registered, so this exercises the new promise-table dedup.
    const { client } = await createClient();

    const first = client.downloadUpdate(fullOnlyInfo);
    const second = client.downloadUpdate(fullOnlyInfo);
    // Let both calls reach the (single) native download, then let it finish.
    await new Promise((r) => setTimeout(r, 10));
    resolveDownload?.();
    const [firstHash, secondHash] = await Promise.all([first, second]);

    expect(firstHash).toBe('new-hash');
    expect(secondHash).toBe('new-hash');
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
  });

  test('a strategy that failed to apply is not downloaded again on later retries (1.6)', async () => {
    const patchError: any = Error('hpatch failed');
    patchError.code = 'PATCH_FAILED';
    const {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(patchError)),
      downloadPatchFromPackage: mock(() =>
        Promise.reject(Error('pdiff offline'))
      ),
      downloadFullUpdate: mock(() => Promise.reject(Error('full offline'))),
    });
    const { client } = await createClient({ maxRetries: 2 });

    await expect(client.downloadUpdate(updateInfo)).rejects.toThrow();

    // Same artifact, same base: the diff can only fail the same way again.
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    // Transport failures are still retried (3 attempts).
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(3);
    expect(downloadFullUpdate).toHaveBeenCalledTimes(3);
  });

  test('retries stop once every strategy has failed deterministically', async () => {
    const reject = () => {
      const err: any = Error('cannot apply');
      err.code = 'PATCH_FAILED';
      return Promise.reject(err);
    };
    const {
      downloadPatchFromPpk,
      downloadPatchFromPackage,
      downloadFullUpdate,
    } = setupDownloadMocks({
      downloadPatchFromPpk: mock(reject),
      downloadPatchFromPackage: mock(reject),
      downloadFullUpdate: mock(reject),
    });
    const { client } = await createClient({ maxRetries: 3 });

    const err: any = await client
      .downloadUpdate(updateInfo)
      .catch((e: any) => e);

    expect(err.code).toBe('PATCH_FAILED');
    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
    expect(downloadFullUpdate).toHaveBeenCalledTimes(1);
  });

  test('downloadFallback carries PATCH_FAILED even when a later transport error came last (P4)', async () => {
    const patchError: any = Error('hpatch failed');
    patchError.code = 'PATCH_FAILED';
    setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(patchError)),
      downloadPatchFromPackage: mock(() =>
        Promise.reject(Error('pdiff offline'))
      ),
    });
    const logger = mock(() => {});
    const { client } = await createClient({
      maxRetries: 0,
      logger,
    });

    expect(await client.downloadUpdate(updateInfo)).toBe('new-hash');

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'downloadFallback',
        data: expect.objectContaining({
          code: 'PATCH_FAILED',
          succeeded: 'full',
          newVersion: 'new-hash',
        }),
      })
    );
  });

  test('a download rescued after a network error is not a patch failure', async () => {
    const timeout: any = Error('请求超时。');
    timeout.code = 'DOWNLOAD_FAILED';
    const { fetchWithTimeout } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(timeout)),
    });
    const { client } = await createClient({ maxRetries: 0 });

    expect(await client.downloadUpdate(updateInfo)).toBe('new-hash');

    expect(serverReports(fetchWithTimeout)).toEqual([
      { type: 'download_success' },
    ]);
  });

  test('a rescued patch failure is reported once, with only the patch error', async () => {
    const patchError: any = Error('hpatch failed');
    patchError.code = 'PATCH_FAILED';
    const timeout: any = Error('请求超时。');
    timeout.code = 'DOWNLOAD_FAILED';
    const { fetchWithTimeout } = setupDownloadMocks({
      downloadPatchFromPpk: mock(() => Promise.reject(patchError)),
      downloadPatchFromPackage: mock(() => Promise.reject(timeout)),
    });
    const { client } = await createClient({ maxRetries: 0 });

    expect(await client.downloadUpdate(updateInfo)).toBe('new-hash');

    // The test i18n renders bare keys: the pdiff timeout is not in detail.
    expect(
      serverReports(fetchWithTimeout).filter(
        ({ type }) => type === 'patch_fail'
      )
    ).toEqual([{ type: 'patch_fail', detail: 'error_diff_failed' }]);
  });

  test('a `[PATCH_FAILED] ` message prefix classifies like a code property (bridge contract)', async () => {
    // Harmony's bridge cannot set `code` on a rejection and prefixes the
    // message instead; the strategy loop must treat it as the same
    // deterministic failure: no second mirror, straight to the next strategy.
    const downloadPatchFromPpk = mock(() =>
      Promise.reject(new Error('[PATCH_FAILED] copiesCrc mismatch'))
    );
    const { downloadPatchFromPackage } = setupDownloadMocks({
      downloadPatchFromPpk,
    });
    const logger = mock(() => {});
    const { client } = await createClient({
      maxRetries: 0,
      logger,
    });

    expect(await client.downloadUpdate(twoMirrors)).toBe('new-hash');

    expect(downloadPatchFromPpk).toHaveBeenCalledTimes(1);
    expect(downloadPatchFromPackage).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'downloadFallback',
        data: expect.objectContaining({ code: 'PATCH_FAILED' }),
      })
    );
  });
});

describe('Cresc class', () => {
  test('uses Cresc server endpoints', async () => {
    setupClientMocks();

    const { client } = await createClient({}, 'Cresc');

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://api.cresc.dev',
      'https://api.cresc.app',
    ]);
  });

  test('defaults locale to en for Cresc', async () => {
    setupClientMocks();
    // Override i18n mock AFTER setupClientMocks to avoid being overwritten
    const setLocale = mock(() => {});
    mockI18n({ setLocale });

    const { Cresc } = await importFreshClient();
    const client = new Cresc({ appKey: 'demo-app' });

    expect(client.clientType).toBe('Cresc');
    expect(setLocale).toHaveBeenCalledWith('en');
  });

  test('explicit locale option overrides clientType default', async () => {
    setupClientMocks();
    const setLocale = mock(() => {});
    mockI18n({ setLocale });

    const { Pushy } = await importFreshClient();
    // Pushy defaults to 'zh'; an explicit 'en' must win.
    new Pushy({ appKey: 'demo-app', locale: 'en' });

    expect(setLocale).toHaveBeenCalledWith('en');
  });

  test('Cresc is instance of Pushy', async () => {
    setupClientMocks();

    const { Cresc, Pushy } = await importFreshClient();
    const client = new Cresc({ appKey: 'demo-app' });

    expect(client).toBeInstanceOf(Pushy);
    expect(client).toBeInstanceOf(Cresc);
  });

  test('Cresc custom server overrides default endpoints', async () => {
    setupClientMocks();

    const { client } = await createClient(
      {
        server: {
          main: ['https://custom.example.com'],
          queryUrls: ['https://q.example.com'],
        },
      },
      'Cresc'
    );

    expect(client.getConfiguredCheckEndpoints()).toEqual([
      'https://custom.example.com',
    ]);
    expect(client.options.server?.queryUrls).toEqual(['https://q.example.com']);
  });
});

describe('resetToPackagedBundle', () => {
  test('calls native reset and clears JS download bookkeeping', async () => {
    const resetToPackagedBundle = mock(() => Promise.resolve());
    const restartApp = mock(() => Promise.resolve());
    setupClientMocks({ resetToPackagedBundle, restartApp });
    const { client, sharedState } = await createClient();
    sharedState.downloadedHash = 'stale-hash';
    sharedState.marked = true;

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(true);
    expect(resetToPackagedBundle).toHaveBeenCalledTimes(1);
    expect(sharedState.downloadedHash).toBeUndefined();
    expect(sharedState.marked).toBe(false);
    // No restart unless explicitly requested.
    expect(restartApp).not.toHaveBeenCalled();
  });

  test('restart: true reloads the app after the reset', async () => {
    const resetToPackagedBundle = mock(() => Promise.resolve());
    const restartApp = mock(() => Promise.resolve());
    setupClientMocks({ resetToPackagedBundle, restartApp });
    const { client } = await createClient();

    await client.resetToPackagedBundle({ restart: true });

    expect(resetToPackagedBundle).toHaveBeenCalledTimes(1);
    expect(restartApp).toHaveBeenCalledTimes(1);
  });

  test('resolves false with RESET_FAILED via onError when the native module lacks the method', async () => {
    // Simulates new JS arriving via hot update onto an older binary. Like the
    // other update-flow APIs this must not throw by default.
    setupClientMocks({ resetToPackagedBundle: null });
    const { client } = await createClient();
    const seen: any[] = [];
    client.onError((err: any) => seen.push(err));

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe('RESET_FAILED');
  });

  test('throwError option makes an unsupported reset throw', async () => {
    setupClientMocks({ resetToPackagedBundle: null });
    const { client } = await createClient({ throwError: true });

    await expect(client.resetToPackagedBundle()).rejects.toMatchObject({
      code: 'RESET_FAILED',
    });
  });

  test('resolves false on native failure and keeps state', async () => {
    const resetToPackagedBundle = mock(() =>
      Promise.reject(Error('disk full'))
    );
    setupClientMocks({ resetToPackagedBundle });
    const { client, sharedState } = await createClient();
    sharedState.downloadedHash = 'stale-hash';
    const seen: any[] = [];
    client.onError((err: any) => seen.push(err));

    const result = await client.resetToPackagedBundle();

    expect(result).toBe(false);
    expect(seen[0].code).toBe('RESET_FAILED');
    expect(seen[0].message).toBe('disk full');
    // The native reset did not happen, so the bookkeeping must not be wiped.
    expect(sharedState.downloadedHash).toBe('stale-hash');
  });
});

describe('downloadAndInstallApk apkStatus (JS-3)', () => {
  test('resets apkStatus after a failed download so retry is possible', async () => {
    // First download fails, second succeeds. The old code unconditionally set
    // apkStatus='downloaded' after a caught failure, permanently blocking retry.
    let callCount = 0;
    const downloadAndInstallApk = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(Error('download fail'));
      }
      return Promise.resolve();
    });
    setupClientMocks({
      platform: 'android',
      downloadAndInstallApk: downloadAndInstallApk,
    });
    const { client, sharedState } = await createClient();

    await client.downloadAndInstallApk('https://example.com/app.apk');
    // Failure must leave apkStatus reset (null), not stuck at 'downloaded'.
    expect(sharedState.apkStatus).toBe(null);

    // A retry should now proceed and reach the native module a second time.
    await client.downloadAndInstallApk('https://example.com/app.apk');
    expect(downloadAndInstallApk).toHaveBeenCalledTimes(2);
    expect(sharedState.apkStatus).toBe('downloaded');
  });
});

describe('client singleton', () => {
  test('a second client with a different appKey throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient();
    const client1 = new Pushy({ appKey: 'app-1' });
    expect(client1.options.appKey).toBe('app-1');

    let error: any;
    try {
      new Pushy({ appKey: 'app-2' });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');
  });

  test('a Cresc client after a Pushy client throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { Pushy, Cresc } = await importFreshClient();
    new Pushy({ appKey: 'app-1' });

    let error: any;
    try {
      new Cresc({ appKey: 'app-1' });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');
  });

  test('re-creating the same client is idempotent and applies the new options', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient();
    const client1 = new Pushy({ appKey: 'app-1', debug: true });
    // e.g. dev fast refresh re-running the module that builds the client
    const client2 = new Pushy({
      appKey: 'app-1',
      updateStrategy: 'silentAndNow',
    });

    expect(client2).toBe(client1);
    expect(client1.options.debug).toBe(true);
    expect(client1.options.updateStrategy).toBe('silentAndNow');
  });

  test('setOptions bumps optionsVersion and notifies subscribers', async () => {
    setupClientMocks();
    const { client } = await createClient({ appKey: 'app-1' });
    const initialVersion = client.optionsVersion;
    const listener = mock(() => {});
    const unsubscribe = client.onOptionsChange(listener);

    client.setOptions({ updateStrategy: 'alwaysAlert' });
    expect(client.optionsVersion).toBe(initialVersion + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    client.setOptions({ updateStrategy: 'silentAndNow' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('a second concurrent provider mount claim throws SINGLETON_VIOLATION', async () => {
    setupClientMocks();
    const { client } = await createClient({ appKey: 'app-1' });

    const release = client.claimProviderMount();
    let error: any;
    try {
      client.claimProviderMount();
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('SINGLETON_VIOLATION');

    // After unmount the claim is released and a new provider may mount.
    release();
    expect(() => client.claimProviderMount()).not.toThrow();
  });
});

describe('syncNativeConfig', () => {
  test('persists the native check config on construction (silent strategy activates)', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient();
    new Pushy({ appKey: 'demo-app', updateStrategy: 'silentAndLater' });

    expect(syncNativeConfig).toHaveBeenCalled();
    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.appKey).toBe('demo-app');
    expect(config.afterDownload).toBe('setNeedUpdate');
    expect(config.endpoints.length).toBeGreaterThan(0);
    expect(config.queryUrls.length).toBeGreaterThan(0);
    expect(config.rnu).toBe('10.0.0');
    expect(config.rn).toBe('0.73.0');
    expect(config.packageVersion).toBe('1.0.0');
  });

  test('disabling automatic checks keeps activation with JS too', async () => {
    // checkStrategy: null means "never check on your own". The native
    // cold-start check still runs (that is what rescues a bricked device),
    // but it must not hand the app a version switch it never asked for —
    // only the server's explicit forceBoot may still activate.
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient();
    new Pushy({
      appKey: 'demo-app',
      updateStrategy: 'silentAndNow',
      checkStrategy: null,
    });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('none');
  });

  test('silent strategy with automatic checks still activates', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient();
    new Pushy({
      appKey: 'demo-app',
      updateStrategy: 'silentAndNow',
      checkStrategy: 'onAppStart',
    });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('setNeedUpdate');
  });

  test('disableNativeCheck writes a disabling config the natives bail on', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient();
    new Pushy({
      appKey: 'demo-app',
      updateStrategy: 'silentAndNow',
      disableNativeCheck: true,
    });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.disabled).toBe(true);
    // No endpoints: the orchestrators return on `disabled` before any IO.
    expect(config.endpoints).toBeUndefined();
    expect(config.appKey).toBe('demo-app');
  });

  test('alert strategies keep activation with JS (afterDownload none)', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { Pushy } = await importFreshClient();
    new Pushy({ appKey: 'demo-app' });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('none');
  });

  test('setOptions re-syncs when the strategy changes', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();
    client.setOptions({ updateStrategy: 'silentAndNow' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('setNeedUpdate');
  });

  test('keeps the last synced config while the options are transiently unusable', async () => {
    // An empty appKey / endpoint list mid-configuration used to be persisted
    // as `{"disabled":true}`, overwriting the last good config and switching
    // off the cold-start rescue for every later launch. Only an explicit
    // disableNativeCheck writes the disabled state.
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    client.setOptions({ appKey: '' });
    client.setOptions({ server: { main: [] } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0])
        .appKey
    ).toBe('demo-app');

    // Once the options are usable again the new config is written.
    client.setOptions({
      appKey: 'demo-app',
      server: { main: ['https://a.example.com'] },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse((syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0])
        .endpoints
    ).toEqual(['https://a.example.com']);
  });

  test('persists and exposes the effective overridden package version', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient({
      overridePackageVersion: '9.9.9',
    });

    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.packageVersion).toBe('9.9.9');
    expect(client.getEffectivePackageVersion()).toBe('9.9.9');
  });

  test('skips duplicate config writes after the same value succeeds', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    client.setOptions({ appKey: 'demo-app' });

    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
  });

  test('serializes config writes and preserves the newest pending value', async () => {
    const resolvers: Array<() => void> = [];
    const syncNativeConfig = mock(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();

    client.setOptions({ updateStrategy: 'silentAndNow' });
    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
    const config = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(config.afterDownload).toBe('setNeedUpdate');
    resolvers[1]();
  });

  test('persists a revert to the last synced value while a newer write is in flight', async () => {
    const resolvers: Array<() => void> = [];
    const syncNativeConfig = mock(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();

    // Finish the initial alert-strategy value (A).
    resolvers[0]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Start B, then revert to A before B finishes. A must remain pending even
    // though it still equals the last completed value at this instant.
    client.setOptions({ updateStrategy: 'silentAndNow' });
    client.setOptions({ updateStrategy: 'alwaysAlert' });
    expect(syncNativeConfig).toHaveBeenCalledTimes(2);

    resolvers[1]();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncNativeConfig).toHaveBeenCalledTimes(3);
    const reverted = JSON.parse(
      (syncNativeConfig.mock.calls.at(-1) as unknown as string[])[0]
    );
    expect(reverted.afterDownload).toBe('none');
    resolvers[2]();
  });

  test('retries a config write that failed', async () => {
    let calls = 0;
    const syncNativeConfig = mock(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('write failed'))
        : Promise.resolve();
    });
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    client.setOptions({ appKey: 'demo-app' });

    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
  });

  test('switching ownership to native and back writes the config again', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(syncNativeConfig).toHaveBeenCalledTimes(1);

    // While native owns it, the host may have stored anything: the old JS
    // value says nothing about native storage any more.
    client.setOptions({ nativeConfigSource: 'native' });
    client.setOptions({ nativeConfigSource: 'javascript' });

    expect(syncNativeConfig).toHaveBeenCalledTimes(2);
    expect(syncNativeConfig.mock.calls[1]).toEqual(
      syncNativeConfig.mock.calls[0]
    );
  });

  test('native ownership suppresses constructor and setOptions writes until handed back', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ syncNativeConfig });
    const { client } = await createClient({
      nativeConfigSource: 'native',
    });
    client.setOptions({ updateStrategy: 'silentAndLater' });
    await Promise.resolve();
    expect(syncNativeConfig).not.toHaveBeenCalled();

    client.setOptions({ nativeConfigSource: 'javascript' });
    expect(syncNativeConfig).toHaveBeenCalledTimes(1);
  });

  test('an older native module without the method is skipped silently', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient();
    // Must not throw even though PushyModule lacks syncNativeConfig.
    new Pushy({ appKey: 'demo-app' });
  });
});

describe('native check cache reuse', () => {
  const expectedRequestBody = JSON.stringify({
    packageVersion: '1.0.0',
    hash: 'hash',
    buildTime: '2023-01-01',
    cInfo: {
      rnu: '10.0.0',
      rn: '0.73.0',
      os: 'ios',
      uuid: 'uuid',
    },
    diffV: 2,
  });

  test('a fresh cached response is reused without a network check', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 30,
          body: JSON.stringify(cachedResult),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    // setup.ts's default fetch throws, so any network attempt would surface
    // as a failed check (undefined) instead of the cached result.
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(cachedResult);
    expect(getNativeCheckCache).toHaveBeenCalled();
  });

  test('a stale cached response falls through to the network', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 600,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('an unreadable cache never breaks the check', async () => {
    const getNativeCheckCache = mock(() => Promise.resolve('not json'));
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { upToDate: true };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('a cache for a different request body is never reused', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify({ hash: 'wrong-hash', update: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'requested-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    expect(await client.checkUpdate({ toHash: 'requested-hash' })).toEqual(
      networkResult
    );
  });

  test('request key order does not prevent reuse of the same request', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify(cachedResult),
          request: JSON.stringify({
            diffV: 2,
            cInfo: {
              uuid: 'uuid',
              os: 'ios',
              rn: '0.73.0',
              rnu: '10.0.0',
            },
            buildTime: '2023-01-01',
            hash: 'hash',
            packageVersion: '1.0.0',
          }),
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(cachedResult);
  });

  test('undefined request extras omitted by JSON do not prevent cache reuse', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify(cachedResult),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const { client } = await createClient();

    expect(await client.checkUpdate({ omitted: undefined })).toEqual(
      cachedResult
    );
  });

  test('a cache for a different native config is never reused', async () => {
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: JSON.stringify({ appKey: 'another-app' }),
        })
      )
    );
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(networkResult);
  });

  test('an expired cache is judged on its age alone and never read again', async () => {
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 600,
          body: JSON.stringify({ upToDate: true }),
          // Never parsed: the age check comes first.
          request: '{not json',
          config: '{not json',
        })
      )
    );
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    const parse = spyOn(JSON, 'parse');
    let parsedCacheFields: unknown[][] = [];
    try {
      expect(await client.checkUpdate()).toEqual(networkResult);
      parsedCacheFields = parse.mock.calls.filter(
        ([text]) => text === '{not json'
      );
    } finally {
      parse.mockRestore();
    }
    expect(parsedCacheFields).toHaveLength(0);
    // A different request (outside the dedup window's identity) re-checks,
    // but the native cache is not consulted again in this process.
    expect(await client.checkUpdate({ toHash: 'other' })).toEqual(
      networkResult
    );
    expect(getNativeCheckCache).toHaveBeenCalledTimes(1);
  });

  test('an absent cache is not read again in the same process', async () => {
    const getNativeCheckCache = mock(() => Promise.resolve(null));
    const syncNativeConfig = mock(() => Promise.resolve());
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { upToDate: true };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    await client.checkUpdate();
    await client.checkUpdate({ toHash: 'other' });

    expect(getNativeCheckCache).toHaveBeenCalledTimes(1);
  });

  test('a config that is canonically equal (C1) still matches the cache', async () => {
    const cachedResult = { upToDate: true };
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() => {
      // What a native normalizer might have stored: trailing slashes, a
      // duplicate endpoint, default-valued keys spelled out, other key order.
      const { endpoints, ...rest } = JSON.parse(configJson);
      const nativeConfig = {
        disabled: false,
        endpoints: [...endpoints.map((url: string) => `${url}/`), endpoints[0]],
        ...rest,
      };
      return Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 10,
          body: JSON.stringify(cachedResult),
          request: expectedRequestBody,
          config: JSON.stringify(nativeConfig),
        })
      );
    });
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(cachedResult);
  });

  test('markJsCheckCompleted is sent once per config after it succeeds', async () => {
    const syncNativeConfig = mock(() => Promise.resolve());
    let markCalls = 0;
    const markJsCheckCompleted = mock(() =>
      ++markCalls === 1 ? Promise.reject(Error('busy')) : Promise.resolve()
    );
    setupClientMocks({ syncNativeConfig, markJsCheckCompleted });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true })
    );
    const { client } = await createClient();
    const flushAll = async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
    };

    // The first acknowledgement failed: the next completed check resends.
    await client.checkUpdate({ round: 1 });
    await flushAll();
    await client.checkUpdate({ round: 2 });
    await flushAll();
    expect(markJsCheckCompleted).toHaveBeenCalledTimes(2);

    // Acknowledged for this config: further checks stay quiet...
    await client.checkUpdate({ round: 3 });
    await flushAll();
    expect(markJsCheckCompleted).toHaveBeenCalledTimes(2);

    // ...until the config changes.
    client.setOptions({ updateStrategy: 'silentAndNow' });
    await client.checkUpdate({ round: 4 });
    await flushAll();
    expect(markJsCheckCompleted).toHaveBeenCalledTimes(3);
  });

  test('a cache timestamp from the future is never reused', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) + 600,
          body: JSON.stringify({ upToDate: true }),
          request: expectedRequestBody,
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const networkResult = { update: true, hash: 'net-hash' };
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(networkResult)
    );
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual(networkResult);
  });
});

describe('checkUpdate request identity', () => {
  const countChecks = (fetchMock: ReturnType<typeof mock>) =>
    fetchMock.mock.calls.filter((call: any[]) =>
      String(call[0]).includes('/checkUpdate/')
    ).length;

  test('identical checks inside the 5s window share one request', async () => {
    setupClientMocks();
    const fetchMock = mock(async () => createJsonResponse({ upToDate: true }));
    (globalThis as any).fetch = fetchMock;
    const { client } = await createClient();

    await client.checkUpdate({ channel: 'beta' });
    await client.checkUpdate({ channel: 'beta' });

    expect(countChecks(fetchMock)).toBe(1);
  });

  test('checks with different extra inside the 5s window never share a response', async () => {
    setupClientMocks();
    const fetchMock = mock(async (_url: string, params: any) => {
      const body = JSON.parse(params.body);
      return createJsonResponse({ update: true, hash: `hash-${body.channel}` });
    });
    (globalThis as any).fetch = fetchMock;
    const { client } = await createClient();

    const a = await client.checkUpdate({ channel: 'a' });
    const b = await client.checkUpdate({ channel: 'b' });

    expect(countChecks(fetchMock)).toBe(2);
    expect((a as any).hash).toBe('hash-a');
    expect((b as any).hash).toBe('hash-b');
  });

  test('extra cannot override the identity fields of the request', async () => {
    setupClientMocks();
    const bodies: any[] = [];
    const fetchMock = mock(async (_url: string, params: any) => {
      bodies.push(JSON.parse(params.body));
      return createJsonResponse({ upToDate: true });
    });
    (globalThis as any).fetch = fetchMock;
    const { client } = await createClient();

    await client.checkUpdate({ packageVersion: '9.9.9', hash: 'forged' });

    expect(bodies[0].packageVersion).toBe('1.0.0');
    // The mocked native currentVersion, not the forged one.
    expect(bodies[0].hash).toBe('hash');
  });

  test('a failed check never returns a previous successful response', async () => {
    setupClientMocks();
    let fail = false;
    const fetchMock = mock(async () => {
      if (fail) {
        throw new Error('offline');
      }
      return createJsonResponse({ update: true, hash: 'old-good' });
    });
    (globalThis as any).fetch = fetchMock;
    const { client } = await createClient();

    expect(((await client.checkUpdate()) as any).hash).toBe('old-good');

    fail = true;
    // Outside the dedup window: this is a fresh check that fails.
    (client as any).lastChecking = Date.now() - 10_000;
    expect(await client.checkUpdate()).toBeUndefined();

    // And the failure cleared the slot: the next call re-asks the server
    // instead of resurrecting the old response through the dedup path.
    const checksAfterFailure = countChecks(fetchMock);
    fail = false;
    expect(((await client.checkUpdate()) as any).hash).toBe('old-good');
    expect(countChecks(fetchMock)).toBeGreaterThan(checksAfterFailure);
  });
});

describe('JS -> native check completion signal', () => {
  test('a successful check marks completion with the synced native config', async () => {
    const markJsCheckCompleted = mock((_config: string) => Promise.resolve());
    const syncNativeConfig = mock((_config: string) => Promise.resolve());
    setupClientMocks({ markJsCheckCompleted, syncNativeConfig });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true })
    );
    const { client } = await createClient();

    await client.checkUpdate();
    await Promise.resolve();

    expect(markJsCheckCompleted).toHaveBeenCalledTimes(1);
    // The very same JSON syncNativeConfig persisted: the native side
    // compares the two strings byte for byte.
    expect(markJsCheckCompleted.mock.calls[0][0]).toBe(
      syncNativeConfig.mock.calls[0][0]
    );
  });

  test('a failed check never marks completion (native rescue must still run)', async () => {
    const markJsCheckCompleted = mock(() => Promise.resolve());
    setupClientMocks({ markJsCheckCompleted });
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });
    const { client } = await createClient();

    expect(await client.checkUpdate()).toBeUndefined();
    expect(markJsCheckCompleted).not.toHaveBeenCalled();
  });

  test('a rejected signal is swallowed and an older native module is skipped', async () => {
    const markJsCheckCompleted = mock(() => Promise.reject(Error('nope')));
    setupClientMocks({ markJsCheckCompleted });
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true })
    );
    const { Pushy } = await importFreshClient();
    const client = new Pushy({ appKey: 'demo-app' });
    expect(await client.checkUpdate()).toEqual({ upToDate: true });

    setupClientMocks();
    const { Pushy: OldPushy } = await importFreshClient();
    const old = new OldPushy({ appKey: 'demo-app' });
    expect(await old.checkUpdate()).toEqual({ upToDate: true });
  });
});

describe('check response schema gate', () => {
  test('a 200 that is not a verdict fails the endpoint and the fallback continues', async () => {
    setupClientMocks();
    let checks = 0;
    (globalThis as any).fetch = mock(async (url: string) => {
      if (String(url).includes('/checkUpdate/')) {
        checks++;
        return createJsonResponse(
          checks === 1 ? { error: 'internal' } : { upToDate: true }
        );
      }
      return createJsonResponse([]);
    });
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual({ upToDate: true });
    expect(checks).toBeGreaterThanOrEqual(2);
  });

  test('when every endpoint returns a non-verdict the check fails', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async (url: string) =>
      createJsonResponse(
        String(url).includes('/checkUpdate/') ? { error: 'internal' } : []
      )
    );
    const { client } = await createClient();
    const seen: any[] = [];
    client.onError((e: any) => {
      seen.push(e);
    });

    expect(await client.checkUpdate()).toBeUndefined();
    expect(seen).toHaveLength(1);
    // The schema-gate code survives the endpoint fallback aggregation.
    expect(seen[0].code).toBe('INVALID_RESPONSE');
  });
});

describe('setOptions (1.3 / 1.11)', () => {
  test('applies a locale change at runtime', async () => {
    const setLocale = mock(() => {});
    setupClientMocks();
    mockI18n({ setLocale });
    const { client } = await createClient({ locale: 'en' });
    expect(setLocale).toHaveBeenLastCalledWith('en');

    client.setOptions({ locale: 'zh' });
    expect(setLocale).toHaveBeenLastCalledWith('zh');
  });

  test('debug gates the verbose log output in release builds', async () => {
    setupClientMocks();
    const { Pushy } = await importFreshClient();
    const { log } = await import('../utils');
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const client = new Pushy({ appKey: 'demo-app' });
      log('hidden');
      expect(logSpy).not.toHaveBeenCalled();

      client.setOptions({ debug: true });
      log('shown');
      expect(logSpy).toHaveBeenCalledTimes(1);

      client.setOptions({ debug: false });
      log('hidden again');
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('getRemoteEndpoints (1.4 / 6.8)', () => {
  test('a mirror answering first with an error page does not beat the healthy one', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async (url: string): Promise<any> => {
      if (url.includes('gitee')) {
        // Fast anti-bot / 404 page: resolves, but is not a list.
        return {
          ok: false,
          status: 404,
          text: async () => '<html>blocked</html>',
          json: async () => {
            throw new Error('not json');
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return createJsonResponse(['https://edge.example.com']);
    });
    const { client } = await createClient();

    expect(await client.getRemoteEndpoints()).toEqual([
      'https://edge.example.com',
    ]);
  });

  test('only https endpoints are accepted from a remote list', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse([
        'http://plain.example.com',
        'https://edge.example.com',
        'ftp://files.example.com',
        'HTTPS://upper.example.com',
        42,
        null,
      ])
    );
    const { client } = await createClient();

    expect(await client.getRemoteEndpoints()).toEqual([
      'https://edge.example.com',
      'HTTPS://upper.example.com',
    ]);
  });

  test('a response that is not a list yields no endpoints', async () => {
    setupClientMocks();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ endpoints: ['https://edge.example.com'] })
    );
    const { client } = await createClient();

    expect(await client.getRemoteEndpoints()).toEqual([]);
  });
});

describe('native check cache schema gate (1.5)', () => {
  test('a cached non-verdict body never becomes "no update"', async () => {
    let configJson = '';
    const syncNativeConfig = mock((value: string) => {
      configJson = value;
      return Promise.resolve();
    });
    // A native old enough to have cached a 200 `{"error": ...}` verbatim.
    const getNativeCheckCache = mock(() =>
      Promise.resolve(
        JSON.stringify({
          ts: Math.floor(Date.now() / 1000) - 30,
          body: JSON.stringify({ error: 'app not found' }),
          request: JSON.stringify({
            packageVersion: '1.0.0',
            hash: 'hash',
            buildTime: '2023-01-01',
            cInfo: { rnu: '10.0.0', rn: '0.73.0', os: 'ios', uuid: 'uuid' },
            diffV: 2,
          }),
          config: configJson,
        })
      )
    );
    setupClientMocks({ getNativeCheckCache, syncNativeConfig });
    const fetchMock = mock(async () => createJsonResponse({ upToDate: true }));
    (globalThis as any).fetch = fetchMock;
    const { client } = await createClient();

    expect(await client.checkUpdate()).toEqual({ upToDate: true });
    expect(getNativeCheckCache).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('switchVersion result and reload watchdog (1.7)', () => {
  const realSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test('resolves true and releases applyingUpdate once the process has outlived the reload', async () => {
    setupClientMocks();
    // Collapse the watchdog delay.
    globalThis.setTimeout = ((fn: (...args: any[]) => void) =>
      realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    const logger = mock(() => {});
    const { client, sharedState } = await createClient({ logger });
    sharedState.downloadedHash = 'next-hash';

    expect(await client.switchVersion('next-hash')).toBe(true);
    expect(sharedState.applyingUpdate).toBe(true);
    // A concurrent second switch is ignored — visibly (false), not silently.
    expect(await client.switchVersion('next-hash')).toBe(false);

    await new Promise((resolve) => realSetTimeout(resolve, 5));
    expect(sharedState.applyingUpdate).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'errorSwitchVersion',
        data: expect.objectContaining({
          code: 'RESTART_FAILED',
          newVersion: 'next-hash',
        }),
      })
    );
    // Later switches are not blocked by the earlier one.
    expect(await client.switchVersion('next-hash')).toBe(true);
  });

  test('resolves false when there is nothing to switch to', async () => {
    setupClientMocks();
    const { client, sharedState } = await createClient();

    expect(await client.switchVersion('next-hash')).toBe(false);
    expect(sharedState.applyingUpdate).toBe(false);
  });

  test('a `[CODE] ` message prefix from a bridge without code support is classified like a code', async () => {
    const reloadUpdate = mock(() =>
      Promise.reject(new Error('[INVALID_OPTIONS] empty hash'))
    );
    setupClientMocks({ reloadUpdate });
    const { client, sharedState } = await createClient();
    sharedState.downloadedHash = 'next-hash';
    const seen: any[] = [];
    client.onError((e: any) => {
      seen.push(e);
    });

    await expect(client.switchVersion('next-hash')).rejects.toThrow(
      'empty hash'
    );
    expect(seen[0].code).toBe('INVALID_OPTIONS');
    expect(seen[0].message).toBe('empty hash');
    expect(sharedState.applyingUpdate).toBe(false);
  });
});

describe('check dedup slot ownership (P4)', () => {
  test("a failing older check does not clear a newer check's slot", async () => {
    setupClientMocks();
    let checkRequests = 0;
    (globalThis as any).fetch = mock(async (url: string, params: any) => {
      if (!url.includes('/checkUpdate/')) {
        throw new Error('no mirrors');
      }
      checkRequests++;
      const body = params?.body ? JSON.parse(params.body) : {};
      if (body.toHash === 'slow-fail') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('offline');
      }
      return createJsonResponse({ upToDate: true });
    });
    const { client } = await createClient();

    const first = client.checkUpdate({ toHash: 'slow-fail' });
    const second = client.checkUpdate({ toHash: 'fast-ok' });
    expect(await second).toEqual({ upToDate: true });
    expect(await first).toBeUndefined();
    const requestsSoFar = checkRequests;

    // Same question as the second check, inside its window: answered from
    // the slot the failed first check must not have cleared.
    expect(await client.checkUpdate({ toHash: 'fast-ok' })).toEqual({
      upToDate: true,
    });
    expect(checkRequests).toBe(requestsSoFar);
  });
});

describe('non-2xx check responses (P4)', () => {
  test('the error text is truncated to 200 characters', async () => {
    setupClientMocks();
    mockI18n({ withParams: true });
    (globalThis as any).fetch = mock(async (url: string) => {
      if (!url.includes('/checkUpdate/')) {
        throw new Error('no mirrors');
      }
      return {
        ok: false,
        status: 502,
        text: async () => 'x'.repeat(1000),
        json: async () => ({}),
      };
    });
    const { client } = await createClient();
    const seen: any[] = [];
    client.onError((e: any) => {
      seen.push(e);
    });

    await client.checkUpdate();

    expect(seen[0].code).toBe('HTTP_STATUS');
    expect(seen[0].message).toContain(`"statusText":"${'x'.repeat(200)}"`);
    expect(seen[0].message).not.toContain('x'.repeat(201));
  });
});

describe('appKey requirement (P4)', () => {
  const setupPlatform = (os: string) => {
    setupClientMocks();
    mockPlatform({ OS: os, Version: 1 });
  };

  test('harmony without an appKey fails fast with APPKEY_REQUIRED', async () => {
    setupPlatform('harmony');
    const { Pushy } = await importFreshClient();

    let error: any;
    try {
      new Pushy({ appKey: '' });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe('APPKEY_REQUIRED');
  });

  test('web tolerates a missing appKey (nothing runs there)', async () => {
    setupPlatform('web');
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { Pushy } = await importFreshClient();
      expect(() => new Pushy({ appKey: '' })).not.toThrow();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
