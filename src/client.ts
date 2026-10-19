import { Platform } from 'react-native';
import { Activation } from './clientActivation';
import { Checker } from './clientCheck';
import { Downloader } from './clientDownload';
import { NativeConfigSync } from './clientNativeConfig';
import { type ReportEvent, Reporter } from './clientReporter';
import { createProcessState } from './clientState';
import { cInfo, isRolledBack, packageVersion, rolledBackVersion } from './core';
import { UpdateError } from './error';
import i18n from './i18n';
import type { ClientOptions, UpdateServerConfig } from './type';
import { dedupeEndpoints } from './updateFlowCore';
import { assertWeb, info, log, noop, setDebugLogging } from './utils';

export type { UpdateErrorListener } from './clientReporter';

// Pushy for China users, Cresc for international ones.
// <generated:service-presets> (scripts/contract.ts; bun scripts/generate-contract.ts)
const SERVER_PRESETS = {
  Pushy: {
    main: [
      'https://update.react-native.cn/api',
      'https://update.reactnative.cn/api',
    ],
    queryUrls: [
      'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
    ],
  },
  Cresc: {
    main: ['https://api.cresc.dev', 'https://api.cresc.app'],
    queryUrls: [
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints_cresc.json',
    ],
  },
};
// </generated:service-presets>

const cloneServerConfig = (server: UpdateServerConfig): UpdateServerConfig => ({
  main: dedupeEndpoints([...(server.main || [])]),
  queryUrls: server.queryUrls ? [...server.queryUrls] : undefined,
});

assertWeb();

// Created once per evaluation of this module, i.e. once per process.
const processState = createProcessState();
export const sharedState = processState.shared;

const createDefaultClientOptions = (): ClientOptions => ({
  appKey: '',
  autoMarkSuccess: true,
  updateStrategy: __DEV__ ? 'alwaysAlert' : 'alertUpdateAndIgnoreError',
  checkStrategy: 'both',
  logger: noop,
  debug: false,
  throwError: false,
  disableErrorReporting: false,
});

// The SDK is a process-level singleton: module-level sharedState, the global
// i18n locale and the native update state are all per-process, so a second
// client would silently share (and fight over) them. Constructing one is a
// hard integration error, except for the idempotent re-creation of the same
// client (same type + appKey), which dev fast-refresh triggers legitimately.
let activeClient: Pushy | undefined;

// The client is a facade: checking (clientCheck), downloading
// (clientDownload), activation (clientActivation), reporting (clientReporter)
// and the native config sync (clientNativeConfig) each own their part of the
// flow; this class owns the options and the process-level singleton, and
// keeps the public API.
// for China users
export class Pushy {
  options: ClientOptions = createDefaultClientOptions();
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  version = cInfo.rnu;

  // `options` is mutated in place, never replaced (see optionsVersion), so
  // the reporter can hold it directly.
  private readonly reporter = new Reporter({
    options: this.options,
    getEffectivePackageVersion: () => this.getEffectivePackageVersion(),
    report: (event) => this.report(event),
    telemetryEndpoint: () =>
      this.checker.lastWorkingEndpoint || this.options.server?.main?.[0],
  });
  private readonly nativeConfig = new NativeConfigSync(this);
  private readonly checker = new Checker(
    this,
    this.reporter,
    this.nativeConfig,
    processState
  );
  private readonly downloader = new Downloader(
    this,
    this.reporter,
    processState
  );
  private readonly activation = new Activation(
    this,
    this.reporter,
    processState
  );

  constructor(options: ClientOptions, clientType?: 'Pushy' | 'Cresc') {
    this.clientType = clientType || 'Pushy';
    if (activeClient) {
      if (
        activeClient.clientType === this.clientType &&
        activeClient.options.appKey === options.appKey
      ) {
        // Same client re-created (e.g. fast refresh re-running the module
        // that builds it): apply the latest options and hand back the
        // existing instance instead of forking process-level state.
        activeClient.setOptions(options);
        // biome-ignore lint/correctness/noConstructorReturn: intentional singleton — identical re-creation must yield the existing instance
        return activeClient;
      }
      throw new UpdateError(
        i18n.t('error_client_singleton'),
        'SINGLETON_VIOLATION'
      );
    }
    this.options.server = cloneServerConfig(SERVER_PRESETS[this.clientType]);

    i18n.setLocale(
      options.locale ?? (this.clientType === 'Pushy' ? 'zh' : 'en')
    );

    // Every native platform (Harmony included) needs the appKey; without it
    // the check URL is `/checkUpdate/` and the failure would surface as an
    // opaque 404 instead of this explicit code.
    if (Platform.OS !== 'web' && !options.appKey) {
      throw new UpdateError(i18n.t('error_appkey_required'), 'APPKEY_REQUIRED');
    }

    this.setOptions(options);
    if (isRolledBack) {
      this.report({
        type: 'rollback',
        data: {
          rolledBackVersion,
        },
      });
    }
    activeClient = this;
  }

  /**
   * Bumped on every setOptions call. `options` is mutated in place (its
   * identity never changes), so reactive consumers (the UpdateProvider)
   * subscribe via onOptionsChange and re-read using this version as the
   * change signal.
   */
  optionsVersion = 0;
  private optionsListeners = new Set<() => void>();
  /**
   * Subscribe to option changes (any setOptions call). Returns an
   * unsubscribe function.
   */
  onOptionsChange = (listener: () => void) => {
    this.optionsListeners.add(listener);
    return () => {
      this.optionsListeners.delete(listener);
    };
  };

  setOptions = (options: Partial<ClientOptions>) => {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (this.options as any)[key] =
          key === 'server'
            ? cloneServerConfig(value as UpdateServerConfig)
            : value;
        if (key === 'logger') {
          this.reporter.loggerPromise.resolve();
        }
        if (key === 'locale') {
          // The constructor applies the initial locale; a runtime switch (or
          // the fast-refresh re-creation path, which only goes through here)
          // must apply just the same.
          i18n.setLocale(value as 'zh' | 'en');
        }
      }
    }
    setDebugLogging(!!this.options.debug);
    this.optionsVersion++;
    for (const listener of this.optionsListeners) {
      try {
        listener();
      } catch (e: any) {
        log('onOptionsChange listener error:', e?.message || e);
      }
    }
    this.reporter.syncAutomaticErrorReporting();
    this.nativeConfig.syncNativeConfig();
  };

  /** Package version used by every server-side update decision. */
  getEffectivePackageVersion = () =>
    this.options.overridePackageVersion || packageVersion;

  private providerMounted = false;
  /**
   * Called by UpdateProvider on mount. A second concurrently mounted
   * provider is the same integration error as a second client — fail hard
   * instead of double-subscribing app-state listeners and update checks.
   * Returns the release function used on unmount.
   */
  claimProviderMount = () => {
    if (this.providerMounted) {
      throw new UpdateError(
        this.t('error_provider_singleton'),
        'SINGLETON_VIOLATION'
      );
    }
    this.providerMounted = true;
    return () => {
      this.providerMounted = false;
    };
  };

  /**
   * Get translated text based on current clientType
   * @param key - Translation key
   * @param values - Values for interpolation (optional)
   * @returns Translated string
   */
  t = (key: string, values?: Record<string, string | number>) => {
    return i18n.t(key as any, values);
  };

  assertDebug = (matter: string) => {
    if (__DEV__ && !this.options.debug) {
      info(this.t('dev_debug_disabled', { matter }));
      return false;
    }
    return true;
  };
  // --- Reporting (clientReporter) ---
  get loggerPromise() {
    return this.reporter.loggerPromise;
  }
  report = (event: ReportEvent) => this.reporter.report(event);
  reportInvalidUpdateOnce: Reporter['reportInvalidUpdateOnce'] = (...args) =>
    this.reporter.reportInvalidUpdateOnce(...args);
  captureException: Reporter['captureException'] = (...args) =>
    this.reporter.captureException(...args);
  enableErrorReporting: Reporter['enableErrorReporting'] = (...args) =>
    this.reporter.enableErrorReporting(...args);
  throwIfEnabled = (e: Error) => this.reporter.throwIfEnabled(e);
  onError: Reporter['onError'] = (listener) => this.reporter.onError(listener);
  wasEmitted = (e: unknown): boolean => this.reporter.wasEmitted(e);
  notifyAfterCheckUpdate: Reporter['notifyAfterCheckUpdate'] = (state) =>
    this.reporter.notifyAfterCheckUpdate(state);

  // --- Checking (clientCheck) ---
  get lastChecking() {
    return this.checker.lastChecking;
  }
  set lastChecking(value) {
    this.checker.lastChecking = value;
  }
  get lastRespJson() {
    return this.checker.lastRespJson;
  }
  set lastRespJson(value) {
    this.checker.lastRespJson = value;
  }
  get lastCheckFingerprint() {
    return this.checker.lastCheckFingerprint;
  }
  set lastCheckFingerprint(value) {
    this.checker.lastCheckFingerprint = value;
  }
  getConfiguredCheckEndpoints = () =>
    this.checker.getConfiguredCheckEndpoints();
  getRemoteEndpoints = () => this.checker.getRemoteEndpoints();
  requestCheckResult: Checker['requestCheckResult'] = (...args) =>
    this.checker.requestCheckResult(...args);
  fetchCheckResult: Checker['fetchCheckResult'] = (fetchPayload) =>
    this.checker.fetchCheckResult(fetchPayload);
  checkUpdate: Checker['checkUpdate'] = (extra) =>
    this.checker.checkUpdate(extra);

  // --- Downloading (clientDownload) ---
  downloadUpdate: Downloader['downloadUpdate'] = (...args) =>
    this.downloader.downloadUpdate(...args);
  downloadAndInstallApk: Downloader['downloadAndInstallApk'] = (...args) =>
    this.downloader.downloadAndInstallApk(...args);

  // --- Activation (clientActivation) ---
  runBeforeReload: Activation['runBeforeReload'] = (context) =>
    this.activation.runBeforeReload(context);
  markSuccess = () => this.activation.markSuccess();
  /** The downloaded version switchVersion(Later) accepts; undefined before a download. */
  getDownloadedHash = (): string | undefined =>
    this.activation.getDownloadedHash();
  /**
   * Reload into a downloaded version. Resolves true once the native reload
   * was requested, false when the call was ignored (not the downloaded hash,
   * a switch already in progress, beforeReload declined, dev without debug).
   */
  switchVersion = (hash: string): Promise<boolean> =>
    this.activation.switchVersion(hash);
  switchVersionLater = (hash: string) =>
    this.activation.switchVersionLater(hash);
  restartApp = () => this.activation.restartApp();
  /**
   * Reset to the bundle packaged in the binary (see
   * Activation.resetToPackagedBundle). Returns whether the reset happened;
   * a false means the app still runs the hot-updated bundle.
   */
  resetToPackagedBundle: Activation['resetToPackagedBundle'] = (options) =>
    this.activation.resetToPackagedBundle(options);
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
