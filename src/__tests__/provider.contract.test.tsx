/**
 * Provider <-> client contract, exercised with the REAL Pushy client (only
 * the native module / core constants are mocked, as in client.test.ts): the
 * provider's lifecycle (mount claim, AppState, timers, option changes)
 * against the client's own option and singleton machinery.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type React from 'react';
import TestRenderer from 'react-test-renderer';
import {
  createClient,
  createJsonResponse,
  flush,
  mockCore,
  mockI18n,
  setDevForFile,
} from './helpers';
import { emitAppStateChange, mockAlert } from './setup';

// Release code paths (assertDebug allows checks, default strategies apply).
setDevForFile(false);

const { useUpdate } = await import('../context');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let importSeq = 0;

// A fresh client (and provider) module per test: the client is a
// process-level singleton (module state), so every test gets its own module
// instance instead of inheriting the previous test's options, listeners and
// dedup window.
const setupRealClient = async (
  options: Record<string, any> = {},
  native: {
    markSuccess?: ReturnType<typeof mock>;
    setNeedUpdate?: ReturnType<typeof mock>;
    isFirstTime?: boolean;
  } = {}
) => {
  mockCore({
    PushyModule: {
      markSuccess: native.markSuccess ?? mock(() => Promise.resolve()),
      reloadUpdate: mock(() => Promise.resolve()),
      setNeedUpdate: native.setNeedUpdate ?? mock(() => Promise.resolve()),
      downloadPatchFromPpk: mock(() => Promise.resolve()),
      downloadPatchFromPackage: mock(() => Promise.resolve()),
      downloadFullUpdate: mock(() => Promise.resolve()),
      downloadAndInstallApk: mock(() => Promise.resolve()),
      restartApp: mock(() => Promise.resolve()),
      resetToPackagedBundle: mock(() => Promise.resolve()),
    },
    isFirstTime: native.isFirstTime ?? false,
  });
  mockI18n({ withParams: true });
  const { client } = await createClient({ appKey: 'contract-app', ...options });
  const { UpdateProvider } = await import(
    `../provider?contract-${++importSeq}`
  );
  // Count the provider's calls into the client without changing what they do.
  const realCheckUpdate = client.checkUpdate;
  const checkUpdate = mock((extra?: Record<string, any>) =>
    realCheckUpdate(extra)
  );
  client.checkUpdate = checkUpdate;
  return { client, UpdateProvider, checkUpdate };
};

const renderProvider = async (
  UpdateProvider: React.ComponentType<any>,
  client: any,
  children?: React.ReactElement
) => {
  let renderer: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <UpdateProvider client={client}>{children ?? <></>}</UpdateProvider>
    );
    await flush();
  });
  return renderer!;
};

describe('UpdateProvider <-> Pushy contract', () => {
  beforeEach(() => {
    mockAlert.mockClear();
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse({ upToDate: true })
    );
  });

  test('a second concurrently mounted provider throws SINGLETON_VIOLATION', async () => {
    const { client, UpdateProvider } = await setupRealClient({
      checkStrategy: null,
    });
    await renderProvider(UpdateProvider, client);

    // React logs the uncaught effect error before rethrowing it.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    let thrown: any;
    try {
      TestRenderer.act(() => {
        TestRenderer.create(
          <UpdateProvider client={client}>
            <></>
          </UpdateProvider>
        );
      });
    } catch (e) {
      thrown = e;
    } finally {
      consoleError.mockRestore();
    }
    expect(thrown?.code).toBe('SINGLETON_VIOLATION');
  });

  test('unmount releases the claim, removes the AppState listener and clears the auto-mark timer', async () => {
    const markSuccess = mock(() => Promise.resolve());
    const { client, UpdateProvider, checkUpdate } = await setupRealClient(
      {
        checkStrategy: 'onAppResume',
        autoMarkSuccess: true,
        autoMarkSuccessDelayMs: 40,
      },
      { markSuccess, isFirstTime: true }
    );
    const renderer = await renderProvider(UpdateProvider, client);
    expect(checkUpdate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      renderer.unmount();
    });
    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await sleep(80);
    expect(markSuccess).not.toHaveBeenCalled();

    // The claim was released: a new provider may mount.
    await renderProvider(UpdateProvider, client);
  });

  test("checkStrategy 'both' checks at mount and on every return to the foreground", async () => {
    const { client, UpdateProvider, checkUpdate } = await setupRealClient({
      checkStrategy: 'both',
    });
    await renderProvider(UpdateProvider, client);
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      emitAppStateChange('background');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(2);
  });

  test('setOptions after mount does not re-run the start check (1.2)', async () => {
    const { client, UpdateProvider, checkUpdate } = await setupRealClient({
      checkStrategy: 'onAppStart',
    });
    await renderProvider(UpdateProvider, client);
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      client.setOptions({ logger: () => {} });
      await flush();
    });
    await TestRenderer.act(async () => {
      client.setOptions({ disableErrorReporting: true });
      await flush();
    });
    expect(checkUpdate).toHaveBeenCalledTimes(1);
  });

  test('switching without an explicit version targets the downloaded one', async () => {
    const setNeedUpdate = mock(() => Promise.resolve());
    const { client, UpdateProvider } = await setupRealClient(
      { checkStrategy: null, updateStrategy: null },
      { setNeedUpdate }
    );
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(UpdateProvider, client, <Probe />);
    const release = (hash: string) => ({
      update: true,
      name: hash,
      hash,
      full: `${hash}.ppk`,
      paths: ['https://cdn.example.com'],
    });

    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(release('hash-a'))
    );
    await TestRenderer.act(async () => {
      await captured.current.checkUpdate();
      await captured.current.downloadUpdate();
      await flush();
    });
    expect(client.getDownloadedHash()).toBe('hash-a');

    // A later check finds a newer release before the user switches; the
    // context's update info moves on to it, but only hash-a is on disk.
    client.lastChecking = 0;
    (globalThis as any).fetch = mock(async () =>
      createJsonResponse(release('hash-b'))
    );
    await TestRenderer.act(async () => {
      await captured.current.checkUpdate();
      await flush();
    });
    expect(captured.current.updateInfo.hash).toBe('hash-b');

    await TestRenderer.act(async () => {
      await captured.current.switchVersionLater();
    });
    expect(setNeedUpdate).toHaveBeenCalledWith({ hash: 'hash-a' });
  });

  test('changing dismissErrorAfter reschedules a running dismiss timer', async () => {
    (globalThis as any).fetch = mock(async () => {
      throw new Error('offline');
    });
    const { client, UpdateProvider } = await setupRealClient({
      updateStrategy: 'alertUpdateAndIgnoreError',
      checkStrategy: 'onAppStart',
      dismissErrorAfter: 40,
    });
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(UpdateProvider, client, <Probe />);
    expect(captured.current.lastError?.code).toBe('CHECK_FAILED');

    await TestRenderer.act(async () => {
      client.setOptions({ dismissErrorAfter: 200 });
      await flush();
    });
    // The original 40ms would have fired by now; the new schedule has not.
    await TestRenderer.act(async () => {
      await sleep(80);
    });
    expect(captured.current.lastError).toBeTruthy();

    await TestRenderer.act(async () => {
      await sleep(200);
    });
    expect(captured.current.lastError).toBeUndefined();
  });
});
