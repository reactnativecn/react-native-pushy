import { DeviceEventEmitter, Platform } from 'react-native';
import {
  buildTime,
  cInfo,
  currentVersion,
  currentVersionInfo,
  getBundleHash,
  isFirstTime,
  isRolledBack,
  nativeMethod,
  PushyModule,
  packageVersion,
  pushyNativeEventEmitter,
  rolledBackVersion,
  setLocalHashInfo,
  supportedDiffVersion,
} from './core';
import { executeEndpointFallback } from './endpoint';
import {
  readErrorCode,
  toUpdateError,
  UpdateError,
  type UpdateErrorCode,
} from './error';
import {
  type ErrorReportContext,
  type ErrorReportingOptions,
  installGlobalErrorHandler,
  type SerializedException,
  serializeException,
} from './errorReporting';
import i18n from './i18n';
import {
  resolveServerEventHash,
  resolveServerEventType,
  truncateDetail,
} from './telemetry';
import type {
  BeforeReloadContext,
  CheckResult,
  ClientOptions,
  EventType,
  ProgressData,
  UpdateCheckState,
  UpdateServerConfig,
} from './type';
import {
  buildCheckFingerprint,
  buildCheckRequestBody,
  type DownloadPlan,
  type DownloadStrategyType,
  decideDownload,
  dedupeEndpoints,
  isMirrorRetryableCode,
  isValidCheckResult,
  jsonDeepEqual,
  nativeConfigsEquivalent,
  resolveCheckResult,
} from './updateFlowCore';
import {
  assertWeb,
  computeProgress,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  info,
  log,
  noop,
  promiseAny,
  setDebugLogging,
  testUrls,
  warn,
} from './utils';

/** One report() event: the logger payload and the source of server telemetry. */
interface ReportEvent {
  type: EventType;
  message?: string;
  code?: UpdateErrorCode;
  data?: Record<string, string | number>;
}

/**
 * Receives every error the client reports, alongside the report event type.
 * The UpdateProvider subscribes to surface errors as lastError/Alert; user
 * code can subscribe too. Listeners run before any throwError rethrow.
 */
export type UpdateErrorListener = (
  error: UpdateError,
  eventType: EventType
) => void;

const SERVER_PRESETS = {
  // cn
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
  // i18n
  Cresc: {
    main: ['https://api.cresc.dev', 'https://api.cresc.app'],
    queryUrls: [
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints_cresc.json',
    ],
  },
};

const cloneServerConfig = (server: UpdateServerConfig): UpdateServerConfig => ({
  main: dedupeEndpoints([...(server.main || [])]),
  queryUrls: server.queryUrls ? [...server.queryUrls] : undefined,
});

// How long after a resolved reloadUpdate the process may still be alive before
// the switch is considered not to have restarted the app (see switchVersion).
const RELOAD_WATCHDOG_MS = 5000;

// Non-2xx check responses are usually HTML error pages; keep only the head
// for the error message (it can end up in an alert) and the logger.
const MAX_HTTP_ERROR_TEXT = 200;

assertWeb();

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

export const sharedState: {
  downloadingTasks: Record<string, Promise<string | undefined>>;
  // Progress callbacks per hash: concurrent downloadUpdate callers of the
  // same hash each register theirs here instead of the second one being
  // silently dropped by the in-flight dedup.
  progressCallbacks: Record<string, Set<(data: ProgressData) => void>>;
  downloadedHash?: string;
  toHash?: string;
  apkStatus: 'downloading' | 'downloaded' | null;
  marked: boolean;
  applyingUpdate: boolean;
} = {
  downloadingTasks: {},
  progressCallbacks: {},
  downloadedHash: undefined,
  apkStatus: null,
  marked: false,
  applyingUpdate: false,
};

// The native cold-start check writes its response cache at most once per
// launch (and skips it once JS has checked), so once this process has seen it
// absent or expired, later reads are near-certain misses: skip the bridge
// call from then on. The rare miss costs one network check. A fresh entry
// that only mismatches the request or config does not set this: a later check
// with the original options (e.g. after `extra` reverts) can still reuse it.
let nativeCheckCacheExhausted = false;
const NATIVE_CHECK_CACHE_MAX_AGE_S = 120;

// In-flight native markSuccess shared by concurrent callers, so the native
// call and its telemetry happen once. Cleared once settled.
let markingPromise: Promise<void> | undefined;

// A reset/new switch invalidates ownership of older async completions and
// watchdogs before the process-wide applyingUpdate flag can be reused.
let applyingUpdateGeneration = 0;
let reloadWatchdogTimer: ReturnType<typeof setTimeout> | undefined;

const clearReloadWatchdog = () => {
  if (reloadWatchdogTimer !== undefined) {
    clearTimeout(reloadWatchdogTimer);
    reloadWatchdogTimer = undefined;
  }
};

const beginApplyingUpdate = (): number => {
  clearReloadWatchdog();
  sharedState.applyingUpdate = true;
  return ++applyingUpdateGeneration;
};

const ownsApplyingUpdate = (generation: number): boolean =>
  generation === applyingUpdateGeneration && sharedState.applyingUpdate;

const finishApplyingUpdate = (generation: number): boolean => {
  if (!ownsApplyingUpdate(generation)) {
    return false;
  }
  clearReloadWatchdog();
  sharedState.applyingUpdate = false;
  return true;
};

const invalidateApplyingUpdate = () => {
  applyingUpdateGeneration++;
  clearReloadWatchdog();
  sharedState.applyingUpdate = false;
};

const armReloadWatchdog = (generation: number, onTimeout: () => void) => {
  if (!ownsApplyingUpdate(generation)) {
    return;
  }
  clearReloadWatchdog();
  const timer = setTimeout(() => {
    // A cancelled callback may already be queued; both identities must match.
    if (reloadWatchdogTimer !== timer || !ownsApplyingUpdate(generation)) {
      return;
    }
    reloadWatchdogTimer = undefined;
    sharedState.applyingUpdate = false;
    onTimeout();
  }, RELOAD_WATCHDOG_MS);
  reloadWatchdogTimer = timer;
};

// The SDK is a process-level singleton: module-level sharedState, the global
// i18n locale and the native update state are all per-process, so a second
// client would silently share (and fight over) them. Constructing one is a
// hard integration error, except for the idempotent re-creation of the same
// client (same type + appKey), which dev fast-refresh triggers legitimately.
let activeClient: Pushy | undefined;

const assertHash = (hash: string) => {
  if (!sharedState.downloadedHash) {
    log(`no downloaded hash yet, ignore switch to ${hash}`);
    return;
  }
  if (hash !== sharedState.downloadedHash) {
    log(`use downloaded hash ${sharedState.downloadedHash} first`);
    return;
  }
  return true;
};

// for China users
export class Pushy {
  options: ClientOptions = createDefaultClientOptions();
  clientType: 'Pushy' | 'Cresc' = 'Pushy';
  lastChecking?: number;
  lastRespJson?: Promise<CheckResult>;
  lastCheckFingerprint?: string;
  // Endpoint that most recently served a successful checkUpdate; telemetry
  // reuses it instead of re-running the fallback race.
  private lastWorkingEndpoint?: string;
  private syncedNativeConfigJson?: string;
  private pendingNativeConfigJson?: string;
  private nativeConfigSyncInFlight = false;
  // Config last acknowledged by markJsCheckCompleted.
  private jsCheckCompletedConfigJson?: string;
  private reportedInvalidUpdates = new Set<string>();
  private reportedExceptions = new WeakSet<object>();
  private globalErrorCleanup?: () => void;

  version = cInfo.rnu;
  loggerPromise = (() => {
    let resolve: (value?: unknown) => void = () => {};
    const promise = new Promise((res) => {
      resolve = res;
    });
    return {
      promise,
      resolve,
    };
  })();

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
          this.loggerPromise.resolve();
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
    this.syncAutomaticErrorReporting();
    this.syncNativeConfig();
  };

  private syncAutomaticErrorReporting = (): void => {
    if (this.options.disableTelemetry || this.options.disableErrorReporting) {
      this.globalErrorCleanup?.();
      return;
    }
    this.enableErrorReporting();
  };

  /** Build the subset of options used by the native cold-start check. */
  private getNativeConfig = (): Record<string, unknown> | undefined => {
    if (!nativeMethod('syncNativeConfig')) {
      // Web, or an older native without the native check.
      return undefined;
    }
    const {
      appKey,
      server,
      updateStrategy,
      checkStrategy,
      disableNativeCheck,
    } = this.options;
    if (disableNativeCheck) {
      // Explicit opt-out: keep the identity fields so the persisted config
      // still describes this app, and let the orchestrators bail on `disabled`
      // before any IO.
      return { disabled: true, appKey, rnu: cInfo.rnu, rn: cInfo.rn };
    }
    if (!appKey || !server?.main?.length) {
      // Unusable rather than merely absent: the JS check would fail on these
      // options too (NO_ENDPOINTS / APPKEY_REQUIRED). The caller turns this
      // into an explicit disabled state.
      return undefined;
    }
    // An app that turned automatic checks off (checkStrategy: null) must not
    // be handed a version switch it never asked for. The cold-start check
    // still runs and still downloads — that is what keeps a bricked device
    // rescuable — but activation waits for the JS side, or for the server's
    // explicit per-version forceBoot directive (shouldActivateAfterDownload).
    const autoCheckEnabled = checkStrategy != null;
    return {
      appKey,
      packageVersion: this.getEffectivePackageVersion(),
      endpoints: server.main,
      queryUrls: server.queryUrls ?? [],
      // The native check may activate a downloaded version (next launch)
      // only under the silent strategies; alert-style strategies keep
      // activation with the JS side (§6/§10.1).
      afterDownload:
        autoCheckEnabled &&
        (updateStrategy === 'silentAndNow' ||
          updateStrategy === 'silentAndLater')
          ? 'setNeedUpdate'
          : 'none',
      rnu: cInfo.rnu,
      rn: cInfo.rn,
    };
  };

  private getNativeConfigJson = (): string | undefined => {
    const config = this.getNativeConfig();
    return config ? JSON.stringify(config) : undefined;
  };

  private flushNativeConfig = () => {
    if (this.options.nativeConfigSource === 'native') {
      this.pendingNativeConfigJson = undefined;
      this.syncedNativeConfigJson = undefined;
      return;
    }
    const sync = nativeMethod('syncNativeConfig');
    if (!sync || this.nativeConfigSyncInFlight) {
      return;
    }
    const configJson = this.pendingNativeConfigJson;
    this.pendingNativeConfigJson = undefined;
    if (!configJson || configJson === this.syncedNativeConfigJson) {
      return;
    }
    this.nativeConfigSyncInFlight = true;
    sync(configJson)
      .then(() => {
        // A switch to 'native' while this write was in flight hands storage
        // to the host; remembering the write would skip it after switching
        // back.
        if (this.options.nativeConfigSource !== 'native') {
          this.syncedNativeConfigJson = configJson;
        }
      })
      .catch((e: any) => {
        log('syncNativeConfig failed:', e?.message || e);
      })
      .finally(() => {
        this.nativeConfigSyncInFlight = false;
        this.flushNativeConfig();
      });
  };

  /**
   * Tell the native cold-start orchestrator that this process already holds a
   * valid check response for the current config, so its delayed round (5s
   * after launch) does not repeat the request. Fire-and-forget: a failure
   * costs one duplicate check. Never called on a failed check — the native
   * rescue must keep running when JS could not reach the server.
   */
  private markJsCheckCompleted = () => {
    const markCompleted = nativeMethod('markJsCheckCompleted');
    if (!markCompleted) {
      return;
    }
    const configJson = this.getNativeConfigJson();
    if (!configJson || configJson === this.jsCheckCompletedConfigJson) {
      return;
    }
    markCompleted(configJson).then(
      () => {
        this.jsCheckCompletedConfigJson = configJson;
      },
      (e: any) => {
        log('markJsCheckCompleted failed:', e?.message || e);
      }
    );
  };

  private syncNativeConfig = () => {
    if (this.options.nativeConfigSource === 'native') {
      // The host owns the stored config now; forget what JS last wrote so a
      // switch back to 'javascript' writes again instead of deduping
      // against a value native storage no longer holds.
      this.pendingNativeConfigJson = undefined;
      this.syncedNativeConfigJson = undefined;
      return;
    }
    if (!nativeMethod('syncNativeConfig')) {
      return;
    }
    const configJson = this.getNativeConfigJson();
    if (!configJson) {
      // No usable config (empty appKey / no endpoints) is almost always a
      // transient state while options are being assembled. Persisting a
      // disabled config over the last good one would switch off the
      // cold-start rescue for every later launch, so keep what native has.
      // (Web and older natives never reach this point — no method.)
      log('native check config unusable, keeping the last synced config');
      return;
    }
    // Always record the latest desired value, even when it matches the last
    // completed write. Example: A synced -> B in flight -> options revert to
    // A. Comparing only with synced(A) would drop the revert and leave native
    // storage at B after that in-flight write completes.
    // Coalesce rapid setOptions calls, but serialize bridge writes so an older
    // completion can never overwrite the newest desired configuration.
    this.pendingNativeConfigJson = configJson;
    this.flushNativeConfig();
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

  reportInvalidUpdateOnce = (
    reason: 'missingHash' | 'noArtifact',
    hash = ''
  ) => {
    const key = `${this.options.appKey}:${reason}:${hash}`;
    if (this.reportedInvalidUpdates.has(key)) {
      return;
    }
    this.reportedInvalidUpdates.add(key);
    this.report({
      type: 'errorUpdate',
      message:
        reason === 'missingHash'
          ? 'update response is missing a version hash'
          : 'update response contains no downloadable artifact',
      ...(hash ? { data: { newVersion: hash } } : {}),
    });
  };

  /**
   * Best-effort JS exception reporting for the currently running OTA release.
   * It is intentionally synchronous to call and never throws; the transport
   * runs in the background and preserves the app's existing error flow.
   */
  captureException = (
    error: unknown,
    context: ErrorReportContext = {}
  ): void => {
    try {
      if (
        __DEV__ ||
        this.options.disableTelemetry ||
        this.options.disableErrorReporting ||
        !currentVersion
      ) {
        return;
      }
      if (
        error !== null &&
        (typeof error === 'object' || typeof error === 'function')
      ) {
        const object = error as object;
        if (this.reportedExceptions.has(object)) {
          return;
        }
        this.reportedExceptions.add(object);
      }
      this.postReport({
        type: 'js_exception',
        hash: currentVersion,
        error: serializeException(error, context),
      });
    } catch (e: any) {
      log('exception telemetry error:', e?.message || e);
    }
  };

  /**
   * Ensure uncaught JS exception capture is installed and return a runtime
   * cleanup function. Capture is installed automatically by default; this
   * method remains an idempotent compatibility hook. The wrapper always
   * chains the handler that was installed before it and only restores that
   * handler when no later integration has replaced ours.
   */
  enableErrorReporting = (
    options: ErrorReportingOptions = {}
  ): (() => void) => {
    if (
      options.captureGlobal === false ||
      this.options.disableTelemetry ||
      this.options.disableErrorReporting
    ) {
      return () => {};
    }
    if (this.globalErrorCleanup) {
      return this.globalErrorCleanup;
    }
    const uninstall = installGlobalErrorHandler((error, isFatal) => {
      this.captureException(error, { fatal: isFatal === true });
    });
    let active = true;
    const cleanup = () => {
      if (!active) {
        return;
      }
      active = false;
      uninstall();
      if (this.globalErrorCleanup === cleanup) {
        this.globalErrorCleanup = undefined;
      }
    };
    this.globalErrorCleanup = cleanup;
    return cleanup;
  };

  report = async ({ type, message = '', code, data = {} }: ReportEvent) => {
    log(`${type} ${code ? `[${code}] ` : ''}${message}`);
    // Fire-and-forget server telemetry; must not wait for the logger below.
    this.reportToServer({ type, message, code, data });
    if (this.options.logger === noop) {
      // Wait briefly for a logger to arrive via setOptions (e.g. the rollback
      // report fires in the constructor before the user configures one), but
      // give up after a bound instead of retaining the closure forever when
      // no logger is ever provided.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.loggerPromise.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => resolve(), 10 * 1000);
        }),
      ]);
      clearTimeout(timer);
    }
    const { logger = noop, appKey } = this.options;
    const overridePackageVersion = this.options.overridePackageVersion;
    try {
      logger({
        type,
        data: {
          appKey,
          currentVersion,
          cInfo,
          packageVersion,
          overridePackageVersion,
          buildTime,
          message,
          code,
          ...currentVersionInfo,
          ...data,
        },
      });
    } catch (e: any) {
      // A user-provided logger must never break the update flow, and report()
      // calls are fire-and-forget so a throw here would be an unhandled
      // rejection.
      log('logger error:', e?.message || e);
    }
  };
  /**
   * Best-effort lifecycle event reporting to the update server (aggregate
   * counts + sampled failure details power the version health view and the
   * rollback safety net server-side). Single POST to the last known working
   * endpoint, no retry, no fallback race; any failure is swallowed — telemetry
   * must never affect the update flow. Opt out with disableTelemetry.
   */
  private reportToServer = ({
    type,
    message,
    code,
    data = {},
  }: ReportEvent) => {
    try {
      if (__DEV__ || this.options.disableTelemetry) {
        return;
      }
      const serverType = resolveServerEventType(type, code);
      if (!serverType) {
        return;
      }
      const hash = resolveServerEventHash({ serverType, data, currentVersion });
      if (!hash) {
        return;
      }
      // A download rescued by a later strategy reports its patch-health
      // signal through downloadFallback, which only counts patch-apply
      // failures; downloadSuccess's data.error (any earlier failure, network
      // errors included) stays local.
      this.postReport({
        type: serverType,
        hash,
        detail: truncateDetail(message),
      });
    } catch (e: any) {
      log('telemetry error:', e?.message || e);
    }
  };
  /**
   * The single telemetry POST ({endpoint}/report/{appKey}) to the last known
   * working endpoint; no retry, failures only logged.
   */
  private postReport = ({
    type,
    hash,
    ...payload
  }: {
    type: string;
    hash: string;
    detail?: string;
    error?: SerializedException;
  }) => {
    const { appKey } = this.options;
    const endpoint = this.lastWorkingEndpoint || this.options.server?.main?.[0];
    if (!appKey || !endpoint) {
      return;
    }
    fetchWithTimeout(`${endpoint}/report/${appKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        hash,
        packageVersion: this.getEffectivePackageVersion(),
        cInfo,
        ...payload,
      }),
    }).catch((e: any) => {
      log('telemetry report failed:', e?.message || e);
    });
  };
  throwIfEnabled = (e: Error) => {
    if (this.options.throwError) {
      throw e;
    }
  };
  private errorListeners = new Set<UpdateErrorListener>();
  private emittedErrors = new WeakSet<Error>();
  /**
   * Subscribe to every error the client reports (regardless of throwError).
   * Returns an unsubscribe function.
   */
  onError = (listener: UpdateErrorListener) => {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  };
  /**
   * Whether this exact error object already went through emitError (and was
   * therefore delivered to onError subscribers). Lets UI layers decide if a
   * caught error still needs surfacing — checking `e.code` is not enough,
   * since axios/system errors carry their own code without ever entering the
   * pipeline.
   */
  wasEmitted = (e: unknown): boolean =>
    e instanceof Error && this.emittedErrors.has(e);
  /**
   * Single exit point for errors: reports to the logger (with the stable
   * code) and notifies onError listeners. Whether to also throw stays with
   * the caller (throwIfEnabled or an unconditional rethrow).
   */
  private emitError = (
    error: UpdateError,
    type: EventType,
    {
      message = error.message,
      data,
    }: { message?: string; data?: Record<string, string | number> } = {}
  ) => {
    this.emittedErrors.add(error);
    this.report({
      type,
      message,
      code: error.code,
      // Structured context from the error (e.g. HTTP status) reaches the
      // logger; explicit data wins on key conflicts.
      data: error.extra ? { ...error.extra, ...data } : data,
    });
    for (const listener of this.errorListeners) {
      try {
        listener(error, type);
      } catch (e: any) {
        log('onError listener error:', e?.message || e);
      }
    }
  };
  /**
   * toUpdateError + emitError: how a caught failure leaves the client.
   * Returns the error for the caller to throw or pass to throwIfEnabled.
   * `fallbackMessage` is reported when the error has no message of its own.
   */
  private fail = (
    e: unknown,
    code: UpdateErrorCode,
    type: EventType,
    {
      message,
      fallbackMessage,
      data,
    }: {
      message?: string;
      fallbackMessage?: string;
      data?: Record<string, string | number>;
    } = {}
  ): UpdateError => {
    const err = toUpdateError(e, code);
    this.emitError(err, type, {
      message: message ?? (err.message || fallbackMessage),
      data,
    });
    return err;
  };
  notifyAfterCheckUpdate = (state: UpdateCheckState) => {
    const { afterCheckUpdate } = this.options;
    if (!afterCheckUpdate) {
      return;
    }
    // 这里仅做状态通知，不阻塞原有检查流程
    Promise.resolve(afterCheckUpdate(state)).catch((error: any) => {
      log('afterCheckUpdate failed:', error?.message || error);
    });
  };
  runBeforeReload = async (context: BeforeReloadContext) => {
    const { beforeReload } = this.options;
    if (!beforeReload) {
      return true;
    }
    const shouldReload = await beforeReload(context);
    if (shouldReload === false) {
      log('beforeReload returned false, skipping reload');
      return false;
    }
    return true;
  };
  // server.main is deduplicated on assignment (cloneServerConfig), and the
  // endpoint plan dedupes again anyway.
  getConfiguredCheckEndpoints = () => this.options.server?.main ?? [];
  getRemoteEndpoints = async () => {
    const { server } = this.options;
    if (!server?.queryUrls?.length) {
      return [];
    }
    try {
      // Race the parsed lists, not the raw responses: fetch resolves for
      // 404/403/5xx and anti-bot HTML too, and this path only runs once the
      // main endpoints are already failing — a mirror that answers first
      // with an error page must not beat the healthy one.
      const remoteEndpoints = await promiseAny(
        server.queryUrls.map(async (queryUrl) => {
          const resp = await fetchWithTimeout(queryUrl, {});
          if (!resp.ok) {
            throw Error(`${queryUrl}: ${resp.status}`);
          }
          const list: unknown = await resp.json();
          if (!Array.isArray(list)) {
            throw Error(`${queryUrl}: not an endpoint list`);
          }
          return list;
        })
      );
      log('fetch endpoints:', remoteEndpoints);
      // Configured and already-failed endpoints are dropped by the endpoint
      // fallback itself.
      return dedupeEndpoints(
        remoteEndpoints.filter(
          // The list is fetched from a public mirror; it may add endpoints
          // but never move the check outside TLS.
          (endpoint): endpoint is string =>
            typeof endpoint === 'string' && /^https:\/\//i.test(endpoint)
        )
      );
    } catch (e) {
      log('failed to fetch endpoints from: ', server.queryUrls, e);
    }
    return [];
  };
  requestCheckResult = async (
    endpoint: string,
    fetchPayload: Parameters<typeof fetch>[1],
    signal?: AbortSignal
  ): Promise<CheckResult> => {
    try {
      const resp = await fetchWithTimeout(
        `${endpoint}/checkUpdate/${this.options.appKey}`,
        fetchPayload,
        DEFAULT_FETCH_TIMEOUT_MS,
        signal
      );

      if (!resp.ok) {
        const respText = (await resp.text()).slice(0, MAX_HTTP_ERROR_TEXT);
        throw new UpdateError(
          this.t('error_http_status', {
            status: resp.status,
            statusText: respText,
          }),
          'HTTP_STATUS',
          { extra: { status: resp.status } }
        );
      }

      const result: unknown = await resp.json();
      if (!isValidCheckResult(result)) {
        // A 2xx that is not a verdict (`{"error": ...}`, a captive-portal
        // page that parsed, ...) is a failed endpoint: throwing keeps the
        // fallback moving to the next one instead of treating it as "no
        // update".
        throw new UpdateError(
          this.t('error_invalid_check_response'),
          'INVALID_RESPONSE'
        );
      }
      return result;
    } catch (e) {
      log('check endpoint failed', endpoint, e);
      throw e;
    }
  };
  fetchCheckResult = async (fetchPayload: Parameters<typeof fetch>[1]) => {
    const { endpoint, value } = await executeEndpointFallback<CheckResult>({
      configuredEndpoints: this.getConfiguredCheckEndpoints(),
      getRemoteEndpoints: this.getRemoteEndpoints,
      tryEndpoint: (currentEndpoint, signal) =>
        this.requestCheckResult(currentEndpoint, fetchPayload, signal),
      onFirstFailure: ({ error }) => {
        this.report({
          type: 'errorChecking',
          message: this.t('error_cannot_connect_backup', {
            message: error.message,
          }),
        });
      },
    });

    log('check endpoint success', endpoint);
    this.lastWorkingEndpoint = endpoint;
    return value;
  };
  /**
   * Reuse the native cold-start check's cached response when fresh
   * (NATIVE_CHECKUPDATE_DESIGN §10.3) instead of re-checking. Returns
   * undefined whenever the cache is absent, stale, or unreadable — any
   * failure falls through to a normal network check.
   */
  private readNativeCheckCache = async (
    requestBody: Record<string, any>
  ): Promise<CheckResult | undefined> => {
    try {
      const getCache = nativeMethod('getNativeCheckCache');
      if (__DEV__ || nativeCheckCacheExhausted || !getCache) {
        return undefined;
      }
      const raw = await getCache();
      if (!raw || typeof raw !== 'string') {
        nativeCheckCacheExhausted = true;
        return undefined;
      }
      const entry = JSON.parse(raw);
      // Age first: it is the common miss and needs no further parsing.
      const ageSeconds =
        typeof entry?.ts === 'number' ? Date.now() / 1000 - entry.ts : NaN;
      if (!(ageSeconds >= 0 && ageSeconds <= NATIVE_CHECK_CACHE_MAX_AGE_S)) {
        nativeCheckCacheExhausted = true;
        return undefined;
      }
      const configJson = this.getNativeConfigJson();
      if (
        typeof entry.body !== 'string' ||
        typeof entry.request !== 'string' ||
        typeof entry.config !== 'string' ||
        !configJson ||
        !nativeConfigsEquivalent(entry.config, configJson) ||
        !jsonDeepEqual(JSON.parse(entry.request), requestBody)
      ) {
        return undefined;
      }
      const result: unknown = JSON.parse(entry.body);
      // Same schema gate as the network path: a native old enough to have
      // cached a 200 `{"error": ...}` must not turn it into "no update".
      if (!isValidCheckResult(result)) {
        return undefined;
      }
      log('reusing native check response cache');
      return result;
    } catch {
      return undefined;
    }
  };

  assertDebug = (matter: string) => {
    if (__DEV__ && !this.options.debug) {
      info(this.t('dev_debug_disabled', { matter }));
      return false;
    }
    return true;
  };
  markSuccess = async () => {
    if (sharedState.marked || __DEV__ || !isFirstTime) {
      return;
    }
    // Concurrent callers (auto mark + an explicit call) would all pass the
    // check above before the first native call settles: share it.
    if (!markingPromise) {
      const promise = this.performMarkSuccess().finally(() => {
        if (markingPromise === promise) {
          markingPromise = undefined;
        }
      });
      markingPromise = promise;
    }
    return markingPromise;
  };
  private performMarkSuccess = async () => {
    try {
      await Promise.resolve(PushyModule.markSuccess());
    } catch (e) {
      throw this.fail(e, 'MARK_SUCCESS_FAILED', 'errorMarkSuccess');
    }
    sharedState.marked = true;
    this.report({ type: 'markSuccess' });
    // 救砖回执:这个版本是被救援通道送进来的,且活过了健康确认——遥测里
    // 一条 rescue 回执就是"这台设备被捞回来了"的证据。
    if (currentVersionInfo.forceBootRescue) {
      this.report({ type: 'forceBootRescue' });
    }
    if (currentVersionInfo.crashRescue) {
      this.report({ type: 'crashRescue' });
    }
  };
  /**
   * Reload into a downloaded version. Resolves true once the native reload
   * was requested, false when the call was ignored (not the downloaded hash,
   * a switch already in progress, beforeReload declined, dev without debug).
   */
  /** The downloaded version switchVersion(Later) accepts; undefined before a download. */
  getDownloadedHash = (): string | undefined => sharedState.downloadedHash;

  switchVersion = async (hash: string): Promise<boolean> => {
    if (!this.assertDebug('switchVersion()')) {
      return false;
    }
    if (!assertHash(hash)) {
      return false;
    }
    if (sharedState.applyingUpdate) {
      log(`switchVersion: ${hash} ignored, a switch is already in progress`);
      return false;
    }
    log(`switchVersion: ${hash}`);
    const applyingGeneration = beginApplyingUpdate();
    try {
      if (!(await this.runBeforeReload({ type: 'switchVersion', hash }))) {
        finishApplyingUpdate(applyingGeneration);
        return false;
      }
    } catch (e) {
      // Release before emitting: an onError listener may retry right away.
      finishApplyingUpdate(applyingGeneration);
      // A throw from the user's beforeReload hook is business-code failure,
      // not an update-pipeline one: give it a distinct code so telemetry
      // excludes it from the server-side patch-health stats.
      throw this.fail(e, 'USER_HOOK_ERROR', 'errorSwitchVersion', {
        data: { newVersion: hash },
      });
    }
    // resetToPackagedBundle may have completed while beforeReload awaited.
    if (!ownsApplyingUpdate(applyingGeneration)) {
      return false;
    }
    try {
      await PushyModule.reloadUpdate({ hash });
    } catch (e) {
      // Do not let a superseded rejection clear a newer switch.
      finishApplyingUpdate(applyingGeneration);
      throw this.fail(e, 'SWITCH_VERSION_FAILED', 'errorSwitchVersion', {
        data: { newVersion: hash },
      });
    }
    // A resolved reloadUpdate normally tears this JS context down right away.
    // iOS has been seen resolving without restarting (89c638e); a stuck
    // applyingUpdate would then silently swallow every later switchVersion,
    // so release it once the process has outlived the reload and tell the
    // logger (RESTART_FAILED: restart mechanics, not patch health).
    armReloadWatchdog(applyingGeneration, () => {
      this.report({
        type: 'errorSwitchVersion',
        code: 'RESTART_FAILED',
        message: 'reloadUpdate resolved but the app did not restart',
        data: { newVersion: hash },
      });
    });
    return true;
  };

  switchVersionLater = async (hash: string) => {
    if (!this.assertDebug('switchVersionLater()')) {
      return;
    }
    if (assertHash(hash)) {
      log(`switchVersionLater: ${hash}`);
      try {
        return await PushyModule.setNeedUpdate({ hash });
      } catch (e) {
        throw this.fail(e, 'SWITCH_VERSION_FAILED', 'errorSwitchVersion', {
          data: { newVersion: hash },
        });
      }
    }
  };
  /**
   * The server answers with the root release plus, during a gray rollout, the
   * candidate `expVersion`. Which of the two applies is decided per device
   * (rollout bucket of this uuid, the running version): every caller of
   * checkUpdate gets that decision, not only the provider — a direct
   * `client.checkUpdate()` → `downloadUpdate()` would otherwise ignore the
   * rollout and install the root release. Idempotent.
   */
  private resolveForThisDevice = (result: CheckResult): CheckResult =>
    result
      ? resolveCheckResult(
          result,
          {
            packageVersion: this.getEffectivePackageVersion(),
            currentVersion,
            uuid: cInfo.uuid,
          },
          log
        )
      : result;

  checkUpdate = async (extra?: Record<string, any>) => {
    if (!this.assertDebug('checkUpdate()')) {
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (!assertWeb()) {
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (
      this.options.beforeCheckUpdate &&
      (await this.options.beforeCheckUpdate()) === false
    ) {
      log('beforeCheckUpdate returned false, skipping check');
      this.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    // 内容寻址的二进制身份,服务端据此精确判定 pdiff 适用性(取代 buildTime
    // 启发式)。同步读 core 里已预取的值:还没算完就省略字段(服务端回退
    // buildTime 启发式),下一次检查自然带上——绝不为它 await、拖慢或复杂化
    // 检查流程。
    const bundleHash = __DEV__ ? '' : getBundleHash();
    const fetchBody = buildCheckRequestBody({
      packageVersion: this.getEffectivePackageVersion(),
      currentVersion,
      buildTime,
      cInfo,
      supportedDiffVersion,
      bundleHash,
      isDev: __DEV__,
      extra,
    });
    const stringifyBody = JSON.stringify(fetchBody);
    // Identity of this check: only a check with the exact same request (same
    // extra / test hash / bundleHash / binary identity) against the same
    // endpoint set may share an in-flight or just-settled response. Two
    // checks 2s apart with different `extra` are different questions.
    const fingerprint = buildCheckFingerprint({
      appKey: this.options.appKey,
      endpoints: this.options.server?.main,
      queryUrls: this.options.server?.queryUrls,
      body: stringifyBody,
    });
    const now = Date.now();
    if (
      this.lastRespJson &&
      this.lastChecking &&
      this.lastCheckFingerprint === fingerprint &&
      now - this.lastChecking < 1000 * 5
    ) {
      try {
        const result = this.resolveForThisDevice(await this.lastRespJson);
        this.notifyAfterCheckUpdate({ status: 'completed', result });
        return result;
      } catch (e: any) {
        // The shared in-flight check failed. Its initiating call reports it
        // through emitError/throw; this call must still honor its own
        // contract — afterCheckUpdate always fires and throwError applies —
        // without double-reporting the same error.
        const err = toUpdateError(e, 'CHECK_FAILED');
        this.notifyAfterCheckUpdate({ status: 'error', error: err });
        this.throwIfEnabled(err);
        return undefined;
      }
    }
    this.lastChecking = now;
    this.lastCheckFingerprint = fingerprint;
    // harmony fetch body is not string
    let body: any = fetchBody;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      body = stringifyBody;
    }
    const fetchPayload = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    };
    let respJsonPromise: Promise<CheckResult> | undefined;
    try {
      this.report({
        type: 'checking',
        message: `${this.options.appKey}: ${stringifyBody}`,
      });
      // The native cold-start check may have a fresh response on disk
      // (§10.3); reuse it instead of re-checking. The read happens INSIDE
      // the promise so no await lands between the dedup window above and the
      // lastRespJson assignment below (the JS2-1 double-send lesson).
      respJsonPromise = (async (): Promise<CheckResult> => {
        // While bundleHash prefetch is still pending, the JS request omits
        // that key whereas the native request always includes its synchronously
        // computed value. That narrow first-launch window intentionally misses
        // the cache rather than delaying checkUpdate for hashing.
        const cached = await this.readNativeCheckCache(fetchBody);
        return cached ?? (await this.fetchCheckResult(fetchPayload));
      })();
      this.lastRespJson = respJsonPromise;
      const rootResult: CheckResult = await respJsonPromise;

      log('checking result:', rootResult);

      if (rootResult?.bundleStatus === 'unknownBundle') {
        // 服务端判定当前二进制内嵌 bundle 未注册,增量已被降级为全量。只面向
        // 开发者(日志 + 遥测,控制台聚合是主渠道);终端用户无感知。
        warn(
          this.t('warn_unknown_bundle', {
            // Each brand ships its own CLI binary (react-native-update-cli).
            cli: this.clientType === 'Cresc' ? 'cresc' : 'pushy',
          })
        );
        this.report({
          type: 'bundleMismatch',
          data: bundleHash ? { bundleHash } : {},
        });
      }

      const result = this.resolveForThisDevice(rootResult);
      this.notifyAfterCheckUpdate({ status: 'completed', result });
      this.markJsCheckCompleted();
      return result;
    } catch (e: any) {
      // A failed check must not keep vouching for an older response: clear
      // the dedup slot so the next call re-asks the server — unless a newer
      // check already owns the slot, which this failure says nothing about.
      if (this.lastRespJson === respJsonPromise) {
        this.lastRespJson = undefined;
        this.lastCheckFingerprint = undefined;
      }
      const err = this.fail(e, 'CHECK_FAILED', 'errorChecking', {
        fallbackMessage: this.t('error_cannot_connect_server'),
      });
      this.notifyAfterCheckUpdate({ status: 'error', error: err });
      this.throwIfEnabled(err);
      // No silent fallback to a previous successful response: a stale result
      // would let a server outage look like "still updatable" and drive the
      // provider's auto-download off it. Return undefined so callers can
      // distinguish "check failed" from a real empty result and keep their
      // last good updateInfo.
      return undefined;
    }
  };
  downloadUpdate = async (
    updateInfo: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    if (
      this.options.beforeDownloadUpdate &&
      (await this.options.beforeDownloadUpdate(updateInfo)) === false
    ) {
      log('beforeDownloadUpdate returned false, skipping download');
      return;
    }
    const decision = decideDownload(
      updateInfo,
      { currentVersion, rolledBackVersion },
      __DEV__
    );
    if (decision.action === 'none') {
      if (decision.reason === 'alreadyCurrent') {
        log(`current hash ${currentVersion}, ignored`);
      } else if (decision.reason === 'rolledBack') {
        log(`rolledback hash ${rolledBackVersion}, ignored`);
      } else if (decision.reason === 'noArtifact') {
        // A server response that advertises an update but provides no usable
        // artifact is a bad release signal, not an ordinary no-update result.
        // Keep the user flow silent and report at most once per bad release in
        // this process: repeated checks must not inflate download_fail health.
        this.reportInvalidUpdateOnce('noArtifact', updateInfo.hash || '');
      }
      return;
    }
    const { hash } = decision;
    if (sharedState.downloadedHash === hash) {
      log(`duplicated downloaded hash ${sharedState.downloadedHash}, ignored`);
      return sharedState.downloadedHash;
    }
    // Deduplicate concurrent downloads of the same hash regardless of whether a
    // progress callback was passed: all callers await the single in-flight
    // promise instead of triggering parallel native downloads.
    const existingTask = sharedState.downloadingTasks[hash];
    if (existingTask) {
      log(`download for hash ${hash} already in progress, reusing it`);
      // The second caller's progress callback must still fire.
      if (onDownloadProgress) {
        sharedState.progressCallbacks[hash]?.add(onDownloadProgress);
      }
      return existingTask;
    }
    const task = this.performDownload(updateInfo, decision, onDownloadProgress);
    sharedState.downloadingTasks[hash] = task;
    try {
      return await task;
    } finally {
      delete sharedState.downloadingTasks[hash];
    }
  };
  /**
   * Orders candidate mirrors for one artifact: the HEAD-race winner first
   * (its post-redirect URL), then the remaining mirrors in configured order.
   * Empty when there is nothing to try.
   */
  private rankDownloadUrls = async (urls?: string[]): Promise<string[]> => {
    if (!urls?.length) {
      return [];
    }
    const winner = await testUrls(urls);
    const ordered: string[] = [];
    const push = (url?: string | null) => {
      if (url && !ordered.includes(url)) {
        ordered.push(url);
      }
    };
    push(winner);
    for (const url of urls) {
      push(url);
    }
    return ordered;
  };
  private performDownload = async (
    updateInfo: CheckResult,
    plan: DownloadPlan,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    const { name, description = '', metaInfo } = updateInfo;
    const { hash, attempts, devNoop } = plan;
    if (devNoop) {
      // Dev without a full package URL: nothing can be fetched, let alone
      // installed. Say so and deliver nothing — faking a success here used to
      // hand the caller a hash whose switchVersion the native side (rightly)
      // rejects with SWITCH_VERSION_FAILED.
      log(this.t('dev_incremental_update_disabled'));
      return;
    }
    const patchStartTime = Date.now();
    // One native listener per hash dispatching to a callback set, so
    // concurrent callers deduped onto this task can each observe progress
    // (they register via downloadUpdate).
    const progressCallbacks = new Set<(data: ProgressData) => void>();
    if (onDownloadProgress) {
      progressCallbacks.add(onDownloadProgress);
    }
    sharedState.progressCallbacks[hash] = progressCallbacks;
    const dispatchProgress = (data: ProgressData) => {
      if (progressCallbacks.size === 0) {
        return;
      }
      const payload = {
        ...data,
        progress: computeProgress(data.received, data.total),
      };
      progressCallbacks.forEach((callback) => {
        // One subscriber throwing must not starve the others or abort the
        // download: business callbacks are isolated, the error is logged.
        try {
          callback(payload);
        } catch (e) {
          warn('onDownloadProgress callback threw', e);
        }
      });
    };
    // RN >= 0.87 types native event listeners as `(...args: readonly Object[])`,
    // which a `(data: ProgressData) => void` callback is not assignable to. Take
    // the raw event and narrow it here so this compiles on every RN version.
    const onNativeProgress = (event: unknown) => {
      const progressData = event as ProgressData;
      if (progressData.hash === hash) {
        dispatchProgress(progressData);
      }
    };
    // @ts-expect-error harmony not in existing platforms
    const isHarmony = Platform.OS === 'harmony';
    const progressSubscription = (
      isHarmony ? DeviceEventEmitter : pushyNativeEventEmitter
    ).addListener('RCTPushyDownloadProgress', onNativeProgress);
    const maxRetries = Math.max(0, Math.floor(this.options.maxRetries ?? 3));
    let succeeded = '';
    let lastError: UpdateError | undefined;
    const errorMessages: string[] = [];
    // A strategy whose bytes arrived but could not be applied fails the same
    // way on every retry (same artifact, same base): remember it — with its
    // message, so the final report still names it — and skip it on later
    // attempts instead of downloading and patching it again.
    const exhaustedStrategies = new Map<DownloadStrategyType, string>();

    // The ordered attempts come from decideDownload (the pure decision layer);
    // this side only executes them: probe candidate URLs, run the matching
    // native download, fall through to the next attempt on failure.
    const runners: Record<
      DownloadStrategyType,
      (url: string) => Promise<void>
    > = {
      diff: (url) =>
        PushyModule.downloadPatchFromPpk({
          updateUrl: url,
          hash,
          originHash: currentVersion,
        }),
      pdiff: (url) =>
        PushyModule.downloadPatchFromPackage({
          updateUrl: url,
          hash,
        }),
      full: (url) =>
        PushyModule.downloadFullUpdate({
          updateUrl: url,
          hash,
        }),
    };
    // Mirror ranking per strategy, kept across retry attempts: the HEAD race
    // runs once per strategy per download instead of once per attempt. A
    // winner that failed its download is demoted to the back for the next
    // attempt (every mirror is tried on every attempt anyway).
    const rankedUrls = new Map<DownloadStrategyType, string[]>();
    const errorKeys = {
      diff: 'error_diff_failed',
      pdiff: 'error_pdiff_failed',
      full: 'error_full_patch_failed',
    } as const;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // Exponential backoff with jitter: a bad CDN edge otherwise gets
          // every client back at the same 1/2/4s marks.
          const backoffMs = Math.round(
            Math.min(1000 * 2 ** (attempt - 1), 10000) *
              (0.75 + Math.random() * 0.5)
          );
          log(`retry attempt ${attempt}/${maxRetries}, waiting ${backoffMs}ms`);
          await new Promise<void>((r) => setTimeout(() => r(), backoffMs));
          errorMessages.length = 0;
          errorMessages.push(...exhaustedStrategies.values());
          lastError = undefined;
          succeeded = '';
        }
        this.report({
          type: 'downloading',
          data: {
            newVersion: hash,
            attempt,
          },
        });
        for (const { type, urls } of attempts) {
          if (succeeded) {
            break;
          }
          if (exhaustedStrategies.has(type)) {
            continue;
          }
          // The HEAD race only ranks mirrors; it is not proof that a mirror can
          // serve the whole artifact (CDNs answer HEAD and GET differently, and
          // a transfer can die mid-stream). Every mirror of the same artifact
          // gets a real download attempt before the strategy is abandoned —
          // the native cold-start path already behaves this way.
          let orderedUrls = rankedUrls.get(type);
          if (!orderedUrls) {
            orderedUrls = await this.rankDownloadUrls(urls);
            rankedUrls.set(type, orderedUrls);
          }
          for (const url of orderedUrls) {
            log(`downloading ${type} from ${url}`);
            try {
              await runners[type](url);
              succeeded = type;
              break;
            } catch (e: unknown) {
              // The native rejection's stable code (e.g. PATCH_FAILED vs
              // DOWNLOAD_FAILED — telemetry classifies on it) may sit on the
              // `code` property or, from bridges that cannot set it, as a
              // `[CODE] ` message prefix. Either way it survives into the
              // i18n-wrapped error together with the original as cause.
              const { code, message } = readErrorCode(e);
              if (url === orderedUrls[0] && orderedUrls.length > 1) {
                rankedUrls.set(type, [...orderedUrls.slice(1), url]);
              }
              const errorMessage = this.t(errorKeys[type], {
                message: message || String(e ?? ''),
              });
              errorMessages.push(errorMessage);
              lastError = new UpdateError(
                errorMessage,
                code ?? 'DOWNLOAD_FAILED',
                {
                  cause: e,
                }
              );
              log(errorMessage);
              if (!isMirrorRetryableCode(lastError.code)) {
                // The bytes arrived but could not be applied (patch/manifest
                // mismatch): every mirror serves the same artifact, so move
                // on to the next strategy instead of re-downloading it.
                exhaustedStrategies.set(type, errorMessage);
                break;
              }
            }
          }
        }
        if (
          succeeded ||
          attempts.every(({ type }) => exhaustedStrategies.has(type))
        ) {
          // Nothing left that a retry could change.
          break;
        }
      }
    } finally {
      progressSubscription.remove();
      delete sharedState.progressCallbacks[hash];
    }
    // Only a patch-stage failure exhausts a strategy (isMirrorRetryableCode),
    // and an exhausted strategy is never retried: these are exactly the patch
    // failures, each once.
    const patchErrorMessages = [...exhaustedStrategies.values()];
    const patchFailed = patchErrorMessages.length > 0;
    if (succeeded && errorMessages.length > 0) {
      // An earlier strategy failed and a later one rescued the download
      // (e.g. pdiff copiesCrc mismatch on a rebuilt binary → full). Surface
      // the degradation: it is invisible to the end user but tells the
      // platform that incremental delivery is failing for this binary.
      this.report({
        type: 'downloadFallback',
        // The patch-health signal (any strategy, in any attempt, failing at
        // the patch stage) wins over whatever transport failure happened to
        // come last (diff PATCH_FAILED, then pdiff network error, then full
        // succeeded is still a patch_fail server-side).
        code: patchFailed ? 'PATCH_FAILED' : lastError?.code,
        data: {
          newVersion: hash,
          succeeded,
        },
        // Only the patch failures: a mirror's timeout alongside them would
        // otherwise be read as the cause server-side.
        message: (patchFailed ? patchErrorMessages : errorMessages).join(';'),
      });
    }
    if (!succeeded) {
      // Every attempt runs at least one download (a plan always has an
      // artifact URL, devNoop returned above), so a failure left lastError.
      throw this.fail(lastError, 'DOWNLOAD_FAILED', 'errorUpdate', {
        message: errorMessages.join(';'),
        data: { newVersion: hash },
      });
    }
    const data: Record<string, any> = {
      newVersion: hash,
      diff: succeeded,
      duration: Date.now() - patchStartTime,
    };
    if (errorMessages.length > 0) {
      data.error = errorMessages.join(';');
    }
    this.report({
      type: 'downloadSuccess',
      data,
    });
    log(`downloaded ${succeeded} hash:`, hash);
    const hashInfo: Record<string, any> = {
      name,
      description,
      metaInfo,
    };
    if (sharedState.toHash === hash) {
      hashInfo.debugChannel = true;
    }
    // The version is "downloaded" only once its metadata is persisted: a
    // lost hash-info write would leave the next launch with a nameless
    // version and a switchVersion that the native side may refuse.
    try {
      await setLocalHashInfo(hash, hashInfo);
    } catch (e: any) {
      throw this.fail(e, 'FILE_OPERATION_FAILED', 'errorUpdate', {
        data: { newVersion: hash },
      });
    }
    sharedState.downloadedHash = hash;
    return hash;
  };
  downloadAndInstallApk = async (
    url: string,
    onDownloadProgress?: (data: ProgressData) => void
  ) => {
    if (Platform.OS !== 'android') {
      return;
    }
    if (sharedState.apkStatus === 'downloading') {
      return;
    }
    if (sharedState.apkStatus === 'downloaded') {
      const err = new UpdateError(
        this.t('error_apk_pending_install'),
        'APK_INSTALL_PENDING'
      );
      this.emitError(err, 'errorInstallApk');
      this.throwIfEnabled(err);
      return;
    }
    sharedState.apkStatus = 'downloading';
    this.report({ type: 'downloadingApk' });
    const progressKey = 'downloadingApk';
    const progressSubscription = onDownloadProgress
      ? pushyNativeEventEmitter.addListener(
          'RCTPushyDownloadProgress',
          (event: unknown) => {
            const progressData = event as ProgressData;
            if (progressData.hash === progressKey) {
              onDownloadProgress(progressData);
            }
          }
        )
      : undefined;
    try {
      await PushyModule.downloadAndInstallApk({
        url,
        target: 'update.apk',
        hash: progressKey,
      });
      sharedState.apkStatus = 'downloaded';
    } catch (e) {
      sharedState.apkStatus = null;
      // Keep the native error (message/stack) instead of discarding it.
      this.throwIfEnabled(
        this.fail(e, 'APK_DOWNLOAD_FAILED', 'errorDownloadAndInstallApk', {
          fallbackMessage: this.t('error_apk_download_failed'),
        })
      );
    } finally {
      progressSubscription?.remove();
    }
  };
  restartApp = async () => {
    try {
      if (!(await this.runBeforeReload({ type: 'restartApp' }))) {
        return;
      }
    } catch (e) {
      throw this.fail(e, 'USER_HOOK_ERROR', 'errorRestart');
    }
    try {
      return await PushyModule.restartApp();
    } catch (e) {
      throw this.fail(e, 'RESTART_FAILED', 'errorRestart');
    }
  };
  /**
   * Reset to the bundle packaged in the binary: wipes the whole update state
   * on the native side, so the app loads the built-in bundle on the next
   * launch (or immediately with `{ restart: true }`), and deletes the
   * downloaded updates in the background (best-effort; the promise does not
   * wait for it). The client uuid is preserved.
   *
   * Returns whether the reset actually happened. Like the other update-flow
   * APIs it never throws by default — failures land in lastError/onError with
   * code RESET_FAILED — but the boolean must not be ignored: a false means the
   * app is still running the hot-updated bundle. Set `throwError` to throw.
   */
  resetToPackagedBundle = async (options?: {
    restart?: boolean;
  }): Promise<boolean> => {
    if (!assertWeb()) {
      return false;
    }
    const reset = nativeMethod('resetToPackagedBundle');
    if (!reset) {
      const err = new UpdateError(
        this.t('error_reset_not_supported'),
        'RESET_FAILED'
      );
      this.emitError(err, 'errorReset');
      this.throwIfEnabled(err);
      return false;
    }
    try {
      await reset();
    } catch (e) {
      this.throwIfEnabled(this.fail(e, 'RESET_FAILED', 'errorReset'));
      return false;
    }
    // The downloaded versions are gone; drop JS bookkeeping referring to them
    // so a stale downloadedHash cannot be switched to.
    sharedState.downloadedHash = undefined;
    sharedState.toHash = undefined;
    sharedState.marked = false;
    // Invalidate the private owner too: old promises/timers must not touch
    // a switch that starts after this reset.
    invalidateApplyingUpdate();
    sharedState.apkStatus = null;
    this.report({ type: 'reset' });
    if (options?.restart) {
      try {
        await this.restartApp();
      } catch (e: any) {
        // The reset itself succeeded and the restart failure was already
        // reported through the pipeline; the boolean must still say "state
        // is reset".
        log('restart after reset failed:', e?.message || e);
      }
    }
    return true;
  };
}

// for international users
export class Cresc extends Pushy {
  constructor(options: ClientOptions) {
    super(options, 'Cresc');
  }
}
