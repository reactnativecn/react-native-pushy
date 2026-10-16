import { Platform } from 'react-native';
import type { Pushy } from './client';
import type { NativeConfigSync } from './clientNativeConfig';
import type { Reporter } from './clientReporter';
import type { ProcessState } from './clientState';
import {
  buildTime,
  cInfo,
  currentVersion,
  getBundleHash,
  nativeMethod,
  supportedDiffVersion,
} from './core';
import { executeEndpointFallback } from './endpoint';
import { toUpdateError, UpdateError } from './error';
import type { CheckResult } from './type';
import {
  buildCheckFingerprint,
  buildCheckRequestBody,
  dedupeEndpoints,
  isValidCheckResult,
  jsonDeepEqual,
  nativeConfigsEquivalent,
  resolveCheckResult,
} from './updateFlowCore';
import {
  assertWeb,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  log,
  promiseAny,
  warn,
} from './utils';

// Non-2xx check responses are usually HTML error pages; keep only the head
// for the error message (it can end up in an alert) and the logger.
const MAX_HTTP_ERROR_TEXT = 200;

const NATIVE_CHECK_CACHE_MAX_AGE_S = 120;

/**
 * What checking needs from the client. Its public members are called through
 * the client, so a caller that replaces one on the instance sees every use.
 */
export type CheckHost = Pick<
  Pushy,
  | 'options'
  | 'clientType'
  | 't'
  | 'assertDebug'
  | 'getEffectivePackageVersion'
  | 'report'
  | 'notifyAfterCheckUpdate'
  | 'throwIfEnabled'
  | 'getConfiguredCheckEndpoints'
  | 'getRemoteEndpoints'
  | 'requestCheckResult'
  | 'fetchCheckResult'
>;

/**
 * The checkUpdate flow: request identity and dedup, the native response
 * cache, the endpoint fallback, the per-device rollout decision.
 */
export class Checker {
  constructor(
    private readonly host: CheckHost,
    private readonly reporter: Reporter,
    private readonly nativeConfig: NativeConfigSync,
    private readonly state: ProcessState
  ) {}

  lastChecking?: number;
  lastRespJson?: Promise<CheckResult>;
  lastCheckFingerprint?: string;
  // Endpoint that most recently served a successful checkUpdate; telemetry
  // reuses it instead of re-running the fallback race.
  lastWorkingEndpoint?: string;

  // server.main is deduplicated on assignment (cloneServerConfig), and the
  // endpoint plan dedupes again anyway.
  getConfiguredCheckEndpoints = () => this.host.options.server?.main ?? [];

  getRemoteEndpoints = async () => {
    const { server } = this.host.options;
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
        `${endpoint}/checkUpdate/${this.host.options.appKey}`,
        fetchPayload,
        DEFAULT_FETCH_TIMEOUT_MS,
        signal
      );

      if (!resp.ok) {
        const respText = (await resp.text()).slice(0, MAX_HTTP_ERROR_TEXT);
        throw new UpdateError(
          this.host.t('error_http_status', {
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
          this.host.t('error_invalid_check_response'),
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
      configuredEndpoints: this.host.getConfiguredCheckEndpoints(),
      getRemoteEndpoints: this.host.getRemoteEndpoints,
      tryEndpoint: (currentEndpoint, signal) =>
        this.host.requestCheckResult(currentEndpoint, fetchPayload, signal),
      onFirstFailure: ({ error }) => {
        this.host.report({
          type: 'errorChecking',
          message: this.host.t('error_cannot_connect_backup', {
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
      if (__DEV__ || this.state.nativeCheckCacheExhausted || !getCache) {
        return undefined;
      }
      const raw = await getCache();
      if (!raw || typeof raw !== 'string') {
        this.state.nativeCheckCacheExhausted = true;
        return undefined;
      }
      const entry = JSON.parse(raw);
      // Age first: it is the common miss and needs no further parsing.
      const ageSeconds =
        typeof entry?.ts === 'number' ? Date.now() / 1000 - entry.ts : NaN;
      if (!(ageSeconds >= 0 && ageSeconds <= NATIVE_CHECK_CACHE_MAX_AGE_S)) {
        this.state.nativeCheckCacheExhausted = true;
        return undefined;
      }
      const configJson = this.nativeConfig.getNativeConfigJson();
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
            packageVersion: this.host.getEffectivePackageVersion(),
            currentVersion,
            uuid: cInfo.uuid,
          },
          log
        )
      : result;

  checkUpdate = async (extra?: Record<string, any>) => {
    const { host } = this;
    const { options } = host;
    if (!host.assertDebug('checkUpdate()')) {
      host.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (!assertWeb()) {
      host.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    if (
      options.beforeCheckUpdate &&
      (await options.beforeCheckUpdate()) === false
    ) {
      log('beforeCheckUpdate returned false, skipping check');
      host.notifyAfterCheckUpdate({ status: 'skipped' });
      return;
    }
    // 内容寻址的二进制身份,服务端据此精确判定 pdiff 适用性(取代 buildTime
    // 启发式)。同步读 core 里已预取的值:还没算完就省略字段(服务端回退
    // buildTime 启发式),下一次检查自然带上——绝不为它 await、拖慢或复杂化
    // 检查流程。
    const bundleHash = __DEV__ ? '' : getBundleHash();
    const fetchBody = buildCheckRequestBody({
      packageVersion: host.getEffectivePackageVersion(),
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
      appKey: options.appKey,
      endpoints: options.server?.main,
      queryUrls: options.server?.queryUrls,
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
        host.notifyAfterCheckUpdate({ status: 'completed', result });
        return result;
      } catch (e: any) {
        // The shared in-flight check failed. Its initiating call reports it
        // through emitError/throw; this call must still honor its own
        // contract — afterCheckUpdate always fires and throwError applies —
        // without double-reporting the same error.
        const err = toUpdateError(e, 'CHECK_FAILED');
        host.notifyAfterCheckUpdate({ status: 'error', error: err });
        host.throwIfEnabled(err);
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
      host.report({
        type: 'checking',
        message: `${options.appKey}: ${stringifyBody}`,
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
        return cached ?? (await host.fetchCheckResult(fetchPayload));
      })();
      this.lastRespJson = respJsonPromise;
      const rootResult: CheckResult = await respJsonPromise;

      log('checking result:', rootResult);

      if (rootResult?.bundleStatus === 'unknownBundle') {
        // 服务端判定当前二进制内嵌 bundle 未注册,增量已被降级为全量。只面向
        // 开发者(日志 + 遥测,控制台聚合是主渠道);终端用户无感知。
        warn(
          host.t('warn_unknown_bundle', {
            // Each brand ships its own CLI binary (react-native-update-cli).
            cli: host.clientType === 'Cresc' ? 'cresc' : 'pushy',
          })
        );
        host.report({
          type: 'bundleMismatch',
          data: bundleHash ? { bundleHash } : {},
        });
      }

      const result = this.resolveForThisDevice(rootResult);
      host.notifyAfterCheckUpdate({ status: 'completed', result });
      this.nativeConfig.markJsCheckCompleted();
      return result;
    } catch (e: any) {
      // A failed check must not keep vouching for an older response: clear
      // the dedup slot so the next call re-asks the server — unless a newer
      // check already owns the slot, which this failure says nothing about.
      if (this.lastRespJson === respJsonPromise) {
        this.lastRespJson = undefined;
        this.lastCheckFingerprint = undefined;
      }
      const err = this.reporter.fail(e, 'CHECK_FAILED', 'errorChecking', {
        fallbackMessage: host.t('error_cannot_connect_server'),
      });
      host.notifyAfterCheckUpdate({ status: 'error', error: err });
      host.throwIfEnabled(err);
      // No silent fallback to a previous successful response: a stale result
      // would let a server outage look like "still updatable" and drive the
      // provider's auto-download off it. Return undefined so callers can
      // distinguish "check failed" from a real empty result and keep their
      // last good updateInfo.
      return undefined;
    }
  };
}
