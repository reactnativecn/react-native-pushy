import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type React from 'react';
import { useContext } from 'react';
import TestRenderer from 'react-test-renderer';
import type { CheckResult, ProgressData } from '../type';
import {
  createClient,
  flush,
  mockCore,
  mockI18n,
  setDevForFile,
} from './helpers';
import { emitAppStateChange, mockAlert } from './setup';

// Render tests exercise the release code paths (assertDebug allows checks).
setDevForFile(false);

const { UpdateProvider } = await import('../provider');
const { UpdateContext, useUpdate, useUpdateProgress } = await import(
  '../context'
);

const updateResult: CheckResult = {
  update: true,
  name: '1.0.1',
  hash: 'next-hash',
  description: 'bugfix',
  full: 'next.ppk',
  paths: ['https://cdn.example.com'],
};

// The real client (a fresh module per call) with the calls the provider makes
// into the update flow spied and stubbed: checks answer `updateResult`,
// downloads deliver 'next-hash' and keep the progress callback for
// emitProgress. Options, onError/wasEmitted, the mount claim and the
// remaining methods are the client's own.
const createSpiedClient = async (options: Record<string, any> = {}) => {
  mockCore({ rolledBackVersion: 'rolled-back-hash' });
  mockI18n({ withParams: true });
  const { client } = await createClient({
    updateStrategy: 'alwaysAlert',
    checkStrategy: 'onAppStart',
    autoMarkSuccess: false,
    ...options,
  });
  let progressCallback: ((data: ProgressData) => void) | undefined;
  spyOn(client, 'checkUpdate').mockImplementation(
    async (): Promise<CheckResult | undefined> => ({ ...updateResult })
  );
  spyOn(client, 'downloadUpdate').mockImplementation(
    async (_info: CheckResult, onProgress?: (data: ProgressData) => void) => {
      progressCallback = onProgress;
      return 'next-hash';
    }
  );
  spyOn(client, 'switchVersion').mockImplementation(async () => true);
  spyOn(client, 'switchVersionLater').mockImplementation(async () => {});
  spyOn(client, 'markSuccess').mockImplementation(async () => {});
  spyOn(client, 'reportInvalidUpdateOnce');
  return Object.assign(client, {
    emitProgress: (data: ProgressData) => progressCallback?.(data),
  });
};

const renderProvider = async (client: any, children?: React.ReactElement) => {
  let renderer: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <UpdateProvider client={client}>{children ?? <></>}</UpdateProvider>
    );
    await flush();
  });
  return renderer!;
};

describe('UpdateProvider rendering', () => {
  beforeEach(() => {
    mockAlert.mockClear();
  });

  test('alwaysAlert strategy alerts when an update is found and downloads on confirm', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    await renderProvider(client);

    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = mockAlert.mock.calls[0] as any[];
    expect(title).toBe('alert_title');

    // Press "confirm" -> downloads, then shows the "update ready" alert.
    await TestRenderer.act(async () => {
      buttons[1].onPress();
      await flush();
    });
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockAlert).toHaveBeenCalledTimes(2);
    const readyButtons = (mockAlert.mock.calls[1] as any[])[2];

    // Press "update now" -> switches version.
    await TestRenderer.act(async () => {
      readyButtons[1].onPress();
      await flush();
    });
    expect(client.switchVersion).toHaveBeenCalledWith('next-hash');
  });

  test('a hash-less update is reported but never shown as an actionable alert', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      update: true,
      name: 'broken rollout entry',
    }));

    await renderProvider(client);

    expect(client.reportInvalidUpdateOnce).toHaveBeenCalledWith('missingHash');
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('an expired app package without a bundle hash keeps its download action', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      expired: true,
      update: true,
      downloadUrl: 'https://cdn.example.com/app-release.apk',
    }));

    await renderProvider(client);

    expect(client.reportInvalidUpdateOnce).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [, , buttons] = mockAlert.mock.calls[0] as any[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].text).toBe('alert_update_button');
  });

  test('an update without a downloadable artifact is never shown as actionable', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      update: true,
      hash: 'broken-artifact-hash',
      name: 'broken release',
      paths: [],
    }));

    await renderProvider(client);

    expect(client.reportInvalidUpdateOnce).toHaveBeenCalledWith(
      'noArtifact',
      'broken-artifact-hash'
    );
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('a rolled-back update is never shown as actionable', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      update: true,
      hash: 'rolled-back-hash',
      full: 'rolled-back-hash.ppk',
      paths: ['https://cdn.example.com'],
    }));

    await renderProvider(client);

    expect(client.checkUpdate).toHaveBeenCalled();
    expect(client.reportInvalidUpdateOnce).not.toHaveBeenCalled();
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('silentAndNow strategy downloads and switches without alerts', async () => {
    const client = await createSpiedClient({ updateStrategy: 'silentAndNow' });
    await renderProvider(client);

    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(client.switchVersion).toHaveBeenCalledWith('next-hash');
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('silentAndLater strategy downloads and defers the switch', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
    });
    await renderProvider(client);

    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(client.switchVersionLater).toHaveBeenCalledWith('next-hash');
    expect(client.switchVersion).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('check failure sets lastError and alerts under alwaysAlert', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    const checkError = new Error('offline');
    // Real client contract under the default throwError:false — the error is
    // emitted to onError listeners and checkUpdate resolves undefined.
    client.checkUpdate.mockImplementation(async () => {
      (client as any).reporter.emitError(checkError, 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.lastError).toBe(checkError);
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect((mockAlert.mock.calls[0] as any[])[0]).toBe(
      'error_update_check_failed'
    );
  });

  test('a user-hook error carrying a foreign code is still surfaced (JS2-4)', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    const hookError: any = new Error('axios network error');
    // axios-style code on an error that never entered the client pipeline;
    // the old `!e?.code` heuristic wrongly treated it as already surfaced.
    hookError.code = 'ERR_NETWORK';
    client.checkUpdate.mockImplementation(async () => {
      throw hookError;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.lastError).toBe(hookError);
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  test('alertUpdateAndIgnoreError suppresses the error alert but keeps lastError', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'alertUpdateAndIgnoreError',
    });
    const checkError = new Error('offline');
    client.checkUpdate.mockImplementation(async () => {
      (client as any).reporter.emitError(checkError, 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.lastError).toBe(checkError);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('dismissErrorAfter clears lastError automatically (JS-4 regression)', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'alertUpdateAndIgnoreError',
      dismissErrorAfter: 20,
    });
    client.checkUpdate.mockImplementation(async () => {
      (client as any).reporter.emitError(new Error('offline'), 'errorChecking');
      return undefined;
    });

    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);
    expect(captured.current.lastError).toBeTruthy();

    await TestRenderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(captured.current.lastError).toBeUndefined();
  });

  test('autoMarkSuccessDelayMs delays the automatic markSuccess', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      autoMarkSuccess: true,
      autoMarkSuccessDelayMs: 40,
    });
    await renderProvider(client);
    expect(client.markSuccess).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(client.markSuccess).toHaveBeenCalledTimes(1);
  });

  test('healthCheck returning false or throwing skips the automatic markSuccess', async () => {
    const unhealthy = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      autoMarkSuccess: true,
      autoMarkSuccessDelayMs: 0,
      healthCheck: async () => false,
    });
    await renderProvider(unhealthy);
    await TestRenderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(unhealthy.markSuccess).not.toHaveBeenCalled();

    const throwing = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      autoMarkSuccess: true,
      autoMarkSuccessDelayMs: 0,
      healthCheck: () => {
        throw new Error('not ready');
      },
    });
    await renderProvider(throwing);
    await TestRenderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(throwing.markSuccess).not.toHaveBeenCalled();

    const healthy = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      autoMarkSuccess: true,
      autoMarkSuccessDelayMs: 0,
      healthCheck: () => true,
    });
    await renderProvider(healthy);
    await TestRenderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(healthy.markSuccess).toHaveBeenCalledTimes(1);
  });

  test('test-channel payloads are refused when testChannel is false', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: null,
      testChannel: false,
    });
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    let handled = true;
    await TestRenderer.act(async () => {
      handled = captured.current.parseTestQrCode(
        JSON.stringify({ type: '__rnPushyVersionHash', data: 'target-hash' })
      );
      await flush();
    });
    expect(handled).toBe(false);
    expect(client.checkUpdate).not.toHaveBeenCalled();
  });

  test('a test-channel check passes toHash without swapping the logger', async () => {
    const logger = mock(() => {});
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: null,
      logger,
    });
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    await TestRenderer.act(async () => {
      captured.current.parseTestQrCode({
        type: '__rnPushyVersionHash',
        data: 'target-hash',
      });
      await flush();
    });
    // The provider unwraps { extra } before handing it to the client.
    expect(client.checkUpdate).toHaveBeenCalledWith({ toHash: 'target-hash' });
    // The user's logger object is left alone for the whole check.
    expect((client.options as any).logger).toBe(logger);
  });

  test('onAppResume strategy checks when the app becomes active', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: 'onAppResume',
    });
    await renderProvider(client);
    expect(client.checkUpdate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
  });

  test('progress ticks re-render progress consumers but not static context consumers (JS-7)', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
    });

    let staticRenders = 0;
    const StaticProbe = () => {
      staticRenders++;
      useContext(UpdateContext);
      return null;
    };
    const progressSeen: ProgressData[] = [];
    const ProgressProbe = () => {
      const progress = useUpdateProgress();
      if (progress) {
        progressSeen.push(progress);
      }
      return null;
    };

    await renderProvider(
      client,
      <>
        <StaticProbe />
        <ProgressProbe />
      </>
    );
    // Download has started (silentAndLater) and captured the progress callback.
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);

    const staticRendersBefore = staticRenders;
    await TestRenderer.act(async () => {
      client.emitProgress({ hash: 'next-hash', received: 1, total: 10 });
      await flush();
    });
    await TestRenderer.act(async () => {
      client.emitProgress({ hash: 'next-hash', received: 5, total: 10 });
      await flush();
    });

    expect(progressSeen.map((p) => p.received)).toEqual([1, 5]);
    expect(staticRenders).toBe(staticRendersBefore);
  });

  test('setOptions on a mounted provider re-runs neither the start check nor the auto-mark timer (1.2)', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      autoMarkSuccess: true,
      autoMarkSuccessDelayMs: 40,
    });
    await renderProvider(client);
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);

    // Two unrelated option changes inside the timer window: a timer reset on
    // each of them would still be pending at 60ms.
    await TestRenderer.act(async () => {
      client.setOptions({ logger: () => {} });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await TestRenderer.act(async () => {
      client.setOptions({ disableErrorReporting: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    expect(client.markSuccess).toHaveBeenCalledTimes(1);
  });

  test('enabling automatic checks after mount runs the start check once', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: null,
    });
    await renderProvider(client);
    expect(client.checkUpdate).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      client.setOptions({ checkStrategy: 'onAppStart' });
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      client.setOptions({ logger: () => {} });
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
  });

  test('a strategy change re-subscribes AppState without another start check', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
      checkStrategy: 'onAppStart',
    });
    await renderProvider(client);
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);

    // onAppStart: no resume listener.
    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);

    await TestRenderer.act(async () => {
      client.setOptions({ checkStrategy: 'both' });
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(1);
    await TestRenderer.act(async () => {
      emitAppStateChange('active');
      await flush();
    });
    expect(client.checkUpdate).toHaveBeenCalledTimes(2);
  });

  test('an expired response with a stray hash-less update is presented as expired-only', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      expired: true,
      update: true,
      downloadUrl: 'https://cdn.example.com/app-release.apk',
    }));
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(captured.current.updateInfo.expired).toBe(true);
    expect(captured.current.updateInfo.update).toBeFalsy();
    expect(client.reportInvalidUpdateOnce).not.toHaveBeenCalled();
    expect(client.downloadUpdate).not.toHaveBeenCalled();
    // The expired alert with its download action is still shown.
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect((mockAlert.mock.calls[0] as any[])[1]).toBe('alert_app_updated');
  });

  test('a silent strategy hands an artifact-less release to the client, which reports it (once)', async () => {
    const client = await createSpiedClient({
      updateStrategy: 'silentAndLater',
    });
    client.checkUpdate.mockImplementation(async () => ({
      update: true,
      hash: 'broken-artifact-hash',
      name: 'broken release',
      paths: [],
    }));
    // The real client reports noArtifact from its download attempt and
    // delivers nothing.
    client.downloadUpdate.mockImplementation(async () => undefined as any);
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(client.reportInvalidUpdateOnce).not.toHaveBeenCalled();
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect((client.downloadUpdate.mock.calls[0] as any[])[0]).toMatchObject({
      hash: 'broken-artifact-hash',
    });
    expect(captured.current.updateInfo).toEqual({ upToDate: true });
    expect(client.switchVersionLater).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  test('a release without a name leaves no {{name}} placeholder in the alert', async () => {
    const client = await createSpiedClient({ updateStrategy: 'alwaysAlert' });
    client.checkUpdate.mockImplementation(async () => ({
      update: true,
      hash: 'next-hash',
      full: 'next.ppk',
      paths: ['https://cdn.example.com'],
    }));
    await renderProvider(client);

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect((mockAlert.mock.calls[0] as any[])[1]).toBe(
      'alert_new_version_found{"name":"","description":""}'
    );
  });

  test('an expired download url the system cannot open becomes lastError, not an unhandled rejection (1.8)', async () => {
    const client = await createSpiedClient({ updateStrategy: 'silentAndNow' });
    client.checkUpdate.mockImplementation(async () => ({
      expired: true,
      downloadUrl: 'market://details?id=app',
    }));
    const { Linking } = await import('react-native');
    (Linking.openURL as any).mockImplementation(() =>
      Promise.reject(new Error('no handler for market://'))
    );
    const captured: { current?: any } = {};
    const Probe = () => {
      captured.current = useUpdate();
      return null;
    };
    await renderProvider(client, <Probe />);

    expect(Linking.openURL).toHaveBeenCalledWith('market://details?id=app');
    expect(captured.current.lastError?.message).toBe(
      'no handler for market://'
    );
    expect(mockAlert).not.toHaveBeenCalled();
  });
  test('the launch deep link is handled once, even when the strategy callbacks change', async () => {
    const { Linking } = await import('react-native');
    const getInitialURL = mock(() =>
      Promise.resolve('app://open?type=__rnPushyVersionHash&data=test-hash')
    );
    (Linking as any).getInitialURL = getInitialURL;
    const client = await createSpiedClient({
      updateStrategy: 'alwaysAlert',
      checkStrategy: null,
    });
    client.checkUpdate.mockImplementation(async () => ({ upToDate: true }));
    await renderProvider(client);

    const testChecks = () =>
      client.checkUpdate.mock.calls.filter(
        (call: any[]) => call[0]?.toHash === 'test-hash'
      ).length;
    expect(getInitialURL).toHaveBeenCalledTimes(1);
    expect(testChecks()).toBe(1);

    // A strategy change rebuilds checkUpdate and with it parseTestPayload;
    // the Linking effect used to re-run and replay the initial URL.
    for (const updateStrategy of ['silentAndNow', 'silentAndLater']) {
      await TestRenderer.act(async () => {
        client.setOptions({ updateStrategy });
        await flush();
      });
    }

    expect(getInitialURL).toHaveBeenCalledTimes(1);
    expect(testChecks()).toBe(1);
  });
});
