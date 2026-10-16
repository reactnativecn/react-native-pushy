import {
  buildTime,
  cInfo,
  currentVersion,
  currentVersionInfo,
  packageVersion,
} from './core';
import { toUpdateError, type UpdateError, type UpdateErrorCode } from './error';
import {
  type ErrorReportContext,
  type ErrorReportingOptions,
  installGlobalErrorHandler,
  type SerializedException,
  serializeException,
} from './errorReporting';
import {
  resolveServerEventHash,
  resolveServerEventType,
  truncateDetail,
} from './telemetry';
import type { ClientOptions, EventType, UpdateCheckState } from './type';
import { fetchWithTimeout, log, noop } from './utils';

/** One report() event: the logger payload and the source of server telemetry. */
export interface ReportEvent {
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

/** What reporting needs from the client. */
export interface ReporterHost {
  readonly options: ClientOptions;
  getEffectivePackageVersion(): string;
  /** The endpoint telemetry posts to: the last one that served a check. */
  telemetryEndpoint(): string | undefined;
}

/**
 * Everything that leaves the client as a signal: the user logger, server
 * telemetry, JS exception reports and the onError listeners. Never throws
 * into the update flow.
 */
export class Reporter {
  constructor(private readonly host: ReporterHost) {}

  private reportedInvalidUpdates = new Set<string>();
  private reportedExceptions = new WeakSet<object>();
  private globalErrorCleanup?: () => void;
  private errorListeners = new Set<UpdateErrorListener>();
  private emittedErrors = new WeakSet<Error>();

  /** Resolved once a logger is configured (see report). */
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

  syncAutomaticErrorReporting = (): void => {
    const { options } = this.host;
    if (options.disableTelemetry || options.disableErrorReporting) {
      this.globalErrorCleanup?.();
      return;
    }
    this.enableErrorReporting();
  };

  reportInvalidUpdateOnce = (
    reason: 'missingHash' | 'noArtifact',
    hash = ''
  ) => {
    const key = `${this.host.options.appKey}:${reason}:${hash}`;
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
      const { options } = this.host;
      if (
        __DEV__ ||
        options.disableTelemetry ||
        options.disableErrorReporting ||
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
      this.host.options.disableTelemetry ||
      this.host.options.disableErrorReporting
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
    if (this.host.options.logger === noop) {
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
    const { logger = noop, appKey } = this.host.options;
    const overridePackageVersion = this.host.options.overridePackageVersion;
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
      if (__DEV__ || this.host.options.disableTelemetry) {
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
    const { appKey } = this.host.options;
    const endpoint = this.host.telemetryEndpoint();
    if (!appKey || !endpoint) {
      return;
    }
    fetchWithTimeout(`${endpoint}/report/${appKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        hash,
        packageVersion: this.host.getEffectivePackageVersion(),
        cInfo,
        ...payload,
      }),
    }).catch((e: any) => {
      log('telemetry report failed:', e?.message || e);
    });
  };

  throwIfEnabled = (e: Error) => {
    if (this.host.options.throwError) {
      throw e;
    }
  };

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
  emitError = (
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
  fail = (
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
    const { afterCheckUpdate } = this.host.options;
    if (!afterCheckUpdate) {
      return;
    }
    // 这里仅做状态通知，不阻塞原有检查流程
    Promise.resolve(afterCheckUpdate(state)).catch((error: any) => {
      log('afterCheckUpdate failed:', error?.message || error);
    });
  };
}
