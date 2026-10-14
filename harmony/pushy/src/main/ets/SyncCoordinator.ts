import http from '@ohos.net.http';
import deviceInfo from '@ohos.deviceInfo';
import logger from './Logger';
import NativePatchCore from './NativePatchCore';
import type { UpdateContext } from './UpdateContext';
import { BundlePreparationRound, bundlePreparationResult } from './BundlePreparationResult';
import type { BundlePreparationResult } from './BundlePreparationResult';
import { isSafePathComponent } from './PathUtils';
import { STATUS_NONE } from './Texts';
import { monotonicNowMs } from './MonotonicClock';
import {
  ERROR_DELTA_FAILED,
  ERROR_DOWNLOAD_FAILED,
  PushyError,
  createPushyError,
  getErrorMessage,
} from './ErrorCodes';

// 原生冷启动检测(NATIVE_CHECKUPDATE_DESIGN §10):每进程一次,getBundleUrl
// 后延迟数秒运行,完全不依赖 app bundle——坏热更把 JS 砸挂后,下次启动仍能
// 拉到修复版。决策全部来自 cpp/update_flow_core(经 NativePatchCore 的
// NAPI 面),本文件只是 IO 胶水。失败静默且有界:每次启动至多一轮,无重试
// 风暴,不拉黑版本。
// 鸿蒙的 debug 门控由触发点天然承担:dev 走 MetroJSBundleProvider,
// PushyFileJSBundleProvider.getBundleUrl 不会被调用。
const TAG = 'NativeSync';
export const KEY_CONFIG = 'nativeConfig';
// 供 JS 侧复用的原始响应缓存(§10.3),同时记录请求与配置指纹以限定命中范围。
export const KEY_RESP_CACHE = 'nativeCheckResp';
// 轮次开始落盘、结束清除(§11.4)。下次启动读到残留 = 上个进程死于轮中
// (砖机的签名),该次启动跳过 5s 延迟立即续传。鸿蒙本版不做 crash-hold
// (errorManager 的同步回调驱动不了 ArkTS 异步网络 IO),续传 + 零延迟
// 标记是收敛砖机的全部机制。
export const KEY_ROUND_INCOMPLETE = 'nativeCheckIncomplete';
const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_CALL_TIMEOUT_MS = 15000;
const MAX_QUERY_HTTP_ATTEMPTS = 8;
const START_DELAY_MS = 5000;
const DOWNLOAD_PHASE_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TYPE_DIFF = 'diff';
const DOWNLOAD_TYPE_PDIFF = 'pdiff';

// 本次启动的事实,交给共享内核(cpp/update_flow_core/native_round.h)。
interface RoundEnv {
  packageVersion: string;
  currentVersion: string;
  uuid: string;
  rolledBackVersion: string;
  buildTime: string;
  os: string;
  bundleHash: string;
}

interface PreparedRound {
  body: string;
  query: Object;
}

interface QueryStep {
  url?: string;
  post?: boolean;
  found?: boolean;
}

interface DecisionAttempt {
  type?: string;
  urls?: string[];
}

interface Decision {
  action?: string;
  reason?: string;
  hash?: string;
  attempts?: DecisionAttempt[];
  activate?: boolean;
  // 要与版本一起持久化的元信息(JS 侧 setLocalHashInfo;forceBootRescue 由内核标记)。
  hashInfo?: Object;
  // 供 JS 复用的响应缓存文本(§10.3)。
  cache?: string;
}

let scheduled = false;
// The host and delayed check use one promise, including its settled result.
const hostRound = new BundlePreparationRound();
let scheduledContext: UpdateContext | undefined;
let scheduledRollback = '';
let roundGeneration = -1;
let roundConfigGeneration = -1;
let roundConfigJson: string | undefined;
let roundResult = bundlePreparationResult('failed', 'check_failed');

function startNativeRound(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<BundlePreparationResult> {
  const preflight = configurationError(context);
  if (preflight !== undefined) {
    return Promise.resolve(preflight);
  }
  return hostRound.run(async () => {
    try {
      await runOnce(context, launchRolledBackVersion);
    } catch (e) {
      logger.error(TAG, `native sync failed: ${getErrorMessage(e)}`);
      roundResult = bundlePreparationResult('failed', 'internal_error');
    }
    return roundResult;
  });
}

interface ConfigRead {
  json: string;
  /** Set when the persisted configuration cannot start a round. */
  rejection?: BundlePreparationResult;
}

// The single configuration gate shared by the preflight, the host API and
// the round itself, so the three can never disagree about what is runnable.
// The verdict is the shared core's (cpp/update_flow_core ParseRunnableConfig,
// also used by Android and iOS).
interface RunnableVerdict {
  status?: string;
  reason?: string;
}

function readNativeConfig(context: UpdateContext): ConfigRead {
  const json = context.getKv(KEY_CONFIG);
  const verdict = JSON.parse(NativePatchCore.runnableConfig(json)) as RunnableVerdict;
  if (verdict.status !== undefined) {
    return {
      json,
      rejection: bundlePreparationResult(verdict.status, verdict.reason ?? ''),
    };
  }
  return { json };
}

// A preflight skip must not consume the process's only round: configuration
// may arrive after the delayed startup timer on a first-ever launch.
function configurationError(context: UpdateContext): BundlePreparationResult | undefined {
  return readNativeConfig(context).rejection;
}

// timeoutMs bounds how long the host waits, as iOS/Android's
// prepareBundle(timeout): on expiry the result is failed/timeout and the round
// keeps running (its result still applies to the next launch). Without one the
// host waits for the round; nothing blocks meanwhile (single-threaded ArkTS).
export async function prepareBundleNative(
  context: UpdateContext,
  timeoutMs?: number,
): Promise<BundlePreparationResult> {
  if (scheduledContext !== context) {
    return bundlePreparationResult('skipped', 'not_initialized');
  }
  const read = readNativeConfig(context);
  if (read.rejection !== undefined) {
    return read.rejection;
  }
  const configJson = read.json;
  const round = startNativeRound(context, scheduledRollback);
  let result: BundlePreparationResult;
  if (timeoutMs === undefined) {
    result = await round;
  } else {
    let timer: number | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
    });
    const settled = await Promise.race([round, expired]);
    clearTimeout(timer);
    if (settled === undefined) {
      return bundlePreparationResult('failed', 'timeout');
    }
    result = settled;
  }
  if (roundConfigGeneration !== context.getNativeConfigGeneration()
      || configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {
    return bundlePreparationResult('cancelled', 'config_changed');
  }
  if (roundGeneration !== context.getResetGeneration()) {
    return bundlePreparationResult('cancelled', 'reset');
  }
  // Do not let a caller mutate the cached result observed by later callers.
  return bundlePreparationResult(result.status, result.reason, result.hash, result.activated);
}

// JS 在本进程内已拿到有效检查响应时对应的配置 JSON(markJsCheckCompleted)。
// 进程级:下次启动无信号,冷启动轮次照常运行。
let jsCompletedConfig: string | undefined;

export function recordJsRound(config: string): void {
  jsCompletedConfig = config;
}

// JS 已用与原生等价的配置(C1:规范形式相同,而非逐字相同——宿主持有的配置
// 与 JS 序列化格式不同)拿到有效响应(§10.3):延迟轮次就是一次重复请求。
// 只有计划内的轮次会问这个问题——JS 没起来、启动即崩、检查失败时都不会有信号。
function hasJsRound(context: UpdateContext): boolean {
  return !!jsCompletedConfig && context.isStoredNativeConfig(jsCompletedConfig);
}

export function scheduleNativeSync(
  context: UpdateContext,
  launchRolledBackVersion: string,
): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  scheduledContext = context;
  scheduledRollback = launchRolledBackVersion;
  // 结果本来就是"下次启动生效",延迟几秒让开冷启动关键路径(§7 R5)——
  // 除非上个进程死于轮中(残留标记),那时每一秒启动时间都要用来续传。
  const delayMs = context.getKv(KEY_ROUND_INCOMPLETE) ? 0 : START_DELAY_MS;
  setTimeout(() => {
    if (hasJsRound(context)) {
      logger.info(
        TAG,
        'native sync skipped: JS already queried in this process',
      );
      return;
    }
    startNativeRound(context, launchRolledBackVersion).catch((e: Object) => {
      // 救援路径自身绝不能把应用拖垮。
      logger.error(TAG, `native sync failed: ${getErrorMessage(e)}`);
    });
  }, delayMs);
}

async function runOnce(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<void> {
  // 在任何 IO 之前采样:resetToPackagedBundle 会递增它,本轮运行期间发生的
  // reset 必须赢过本轮的决策。
  const resetGeneration = context.getResetGeneration();
  roundGeneration = resetGeneration;
  roundConfigGeneration = context.getNativeConfigGeneration();
  roundResult = bundlePreparationResult('failed', 'check_failed');
  const read = readNativeConfig(context);
  roundConfigJson = read.json;
  if (read.rejection !== undefined) {
    roundResult = read.rejection;
    return;
  }
  const configJson = read.json;
  // 从这里起本轮开始做真实工作:留下面包屑,死于轮中时下次启动零延迟续传。
  logger.info(
    TAG,
    `round started (resume=${!!context.getKv(KEY_ROUND_INCOMPLETE)})`,
  );
  // 面包屑只是"下次零延迟"的优化:落盘失败不能阻止救援轮次本身。
  try {
    await context.setKv(KEY_ROUND_INCOMPLETE, '1');
  } catch (e) {
    logger.warn(TAG, `cannot persist round marker: ${getErrorMessage(e)}`);
  }
  try {
    await runConfiguredRound(
      context,
      launchRolledBackVersion,
      resetGeneration,
      configJson,
    );
  } finally {
    try {
      await context.removeKv(KEY_ROUND_INCOMPLETE);
    } catch (e) {
      // 残留标记只意味着下次启动少等 5 秒。
      logger.warn(TAG, `cannot clear round marker: ${getErrorMessage(e)}`);
    }
  }
}

async function runConfiguredRound(
  context: UpdateContext,
  launchRolledBackVersion: string,
  resetGeneration: number,
  configJson: string,
): Promise<void> {
  const currentVersion = context.getCurrentVersion();
  const env: RoundEnv = {
    packageVersion: context.getPackageVersion(),
    // 与 JS 常量同形(无版本时为 ''),JS 才能复用这次请求的响应缓存。
    currentVersion,
    uuid: context.getKv('uuid') ?? '',
    // getConstants consumes the persisted rollback marker during startup; use
    // the launch-path snapshot captured before that happens.
    rolledBackVersion: launchRolledBackVersion,
    buildTime: context.getBuildTime(),
    // RNOH's Platform.Version is osFullName; use the same value so JS can
    // reuse the response cache produced by this native request.
    os: `harmony ${deviceInfo.osFullName}`,
    bundleHash: await context.getBundleHash(),
  };
  const envJson = JSON.stringify(env);
  const preparedJson = NativePatchCore.prepareRound(configJson, envJson, Math.random());
  if (!preparedJson) {
    roundResult = bundlePreparationResult('failed', 'invalid_request');
    return;
  }
  const prepared = JSON.parse(preparedJson) as PreparedRound;
  const responseText = await runQueryRequest(
    JSON.stringify(prepared.query),
    prepared.body,
  );
  if (!responseText) {
    logger.warn(TAG, 'no endpoint reachable, giving up until next launch');
    return;
  }
  // 规划好的 attempts、hashInfo 与响应缓存(时间戳取响应到达时)都来自共享内核。
  const decisionJson = NativePatchCore.handleResponse(
    responseText,
    configJson,
    envJson,
    prepared.body,
    Math.floor(Date.now() / 1000),
  );
  if (!decisionJson) {
    roundResult = bundlePreparationResult('failed', 'invalid_response');
    return;
  }
  const decision = JSON.parse(decisionJson) as Decision;
  const responseCacheJson = decision.cache ?? '';
  // Commits the round's persistent outcome (see commitSyncResult) and maps
  // it to the round result; a reset during the round wins over `result`.
  const commit = async (
    hash: string,
    hashInfoJson: string,
    activate: boolean,
    result: BundlePreparationResult,
  ): Promise<boolean> => {
    const committed = await context.commitSyncResult(
      resetGeneration,
      hash,
      hashInfoJson,
      activate,
      responseCacheJson,
    );
    roundResult = committed
      ? result
      : bundlePreparationResult('cancelled', 'reset');
    return committed;
  };

  if (decision.action !== 'download') {
    await commit(
      '',
      '',
      false,
      bundlePreparationResult(STATUS_NONE, decision.reason ?? ''),
    );
    logger.info(TAG, `nothing to do (${decision.reason ?? ''})`);
    return;
  }
  const hash = decision.hash ?? '';
  if (!isSafePathComponent(hash)) {
    logger.warn(TAG, 'decision carries an unsafe hash, ignoring');
    roundResult = bundlePreparationResult('failed', 'invalid_response');
    return;
  }

  let downloaded = context.hasDownloadedVersion(hash);
  if (downloaded) {
    logger.info(TAG, `${hash} already installed, skipping download`);
  } else {
    logger.info(TAG, `downloading ${hash}`);
    downloaded = await performAttempts(
      context,
      decision.attempts ?? [],
      hash,
      currentVersion,
    );
  }
  if (!downloaded) {
    logger.warn(TAG, `all download attempts for ${hash} failed`);
    await commit('', '', false, bundlePreparationResult('failed', 'download_failed'));
    return;
  }

  const hashInfoJson = JSON.stringify(decision.hashInfo);

  // 版本元信息、激活与响应缓存一次性原子提交(见 commitSyncResult);
  // 缓存只在原生文件/状态工作结束后公开,避免 JS 观察到响应后并发下载。
  // 静默策略、或服务端按版本标记的 forceBoot(远程覆盖,救砖指令)才激活。
  const activate = decision.activate === true;
  let committed = false;
  try {
    committed = await commit(
      hash,
      hashInfoJson,
      activate,
      bundlePreparationResult('downloaded', '', hash, activate),
    );
  } catch (e) {
    logger.error(TAG, `commit failed: ${getErrorMessage(e)}`);
    roundResult = bundlePreparationResult('failed', 'commit_failed');
    return;
  }
  if (!committed) {
    logger.warn(TAG, 'reset during round, dropping result');
  } else if (activate) {
    logger.info(TAG, `downloaded ${hash} and set for next launch`);
  } else {
    logger.info(TAG, `downloaded ${hash}, activation left to JS`);
  }
}

async function httpRequest(
  url: string,
  postBody?: string,
): Promise<string | undefined> {
  const client = http.createHttp();
  let callTimer: number | null = null;
  try {
    const header: Record<string, string> = { Accept: 'application/json' };
    if (postBody !== undefined) {
      header['Content-Type'] = 'application/json';
    }
    const requestPromise = client.request(url, {
      method: postBody !== undefined
        ? http.RequestMethod.POST
        : http.RequestMethod.GET,
      header,
      extraData: postBody,
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      expectDataType: http.HttpDataType.STRING,
    });
    const timeoutPromise = new Promise<http.HttpResponse>((_, reject) => {
      callTimer = setTimeout(() => {
        reject(Error(`HTTP request exceeded ${REQUEST_CALL_TIMEOUT_MS}ms`));
      }, REQUEST_CALL_TIMEOUT_MS);
    });
    const response = await Promise.race([requestPromise, timeoutPromise]);
    if (
      response.responseCode >= 200 &&
      response.responseCode < 300 &&
      typeof response.result === 'string'
    ) {
      return response.result;
    }
    return undefined;
  } catch (e) {
    return undefined;
  } finally {
    if (callTimer !== null) {
      clearTimeout(callTimer);
    }
    client.destroy();
  }
}

// 顺序回退(§5.1):按共享内核给出的下一步逐个请求,单请求超时
// (NativePatchCore.nextQueryStep:候选序、queryUrls 发现、远程端点的 https
// 门槛、请求预算、响应 schema)。刻意不做 hedged race——该路径对延迟不敏感。
async function runQueryRequest(
  query: string,
  body: string,
): Promise<string | undefined> {
  let state: string | undefined = query;
  let text: string | undefined = undefined;
  while (state !== undefined) {
    state = NativePatchCore.nextQueryStep(state, text);
    if (state === undefined) {
      break;
    }
    const step = JSON.parse(state) as QueryStep;
    if (step.found) {
      return text;
    }
    if (!step.url) {
      break;
    }
    text = await httpRequest(step.url, step.post ? body : undefined);
  }
  return undefined;
}

async function runWithinDeadline(
  start: () => Promise<void>,
  deadlineUptimeMs: number,
): Promise<void> {
  const remainingMs = deadlineUptimeMs - monotonicNowMs();
  if (remainingMs <= 0) {
    throw createPushyError(
      ERROR_DOWNLOAD_FAILED,
      'Download phase deadline expired before start',
    );
  }
  let deadlineTimer = 0;
  const deadlinePromise = new Promise<void>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(
        createPushyError(
          ERROR_DOWNLOAD_FAILED,
          'Download phase deadline exceeded',
        ),
      );
    }, remainingMs);
  });
  try {
    // This bounds queueing, HTTP, decompression and native hpatch work from
    // the orchestrator's perspective. The serialized task may still finish
    // later, but it can no longer prevent the response cache from settling.
    await Promise.race([start(), deadlinePromise]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function performAttempts(
  context: UpdateContext,
  attempts: DecisionAttempt[],
  hash: string,
  originHash: string,
): Promise<boolean> {
  const incrementalDeadline = monotonicNowMs() + DOWNLOAD_PHASE_TIMEOUT_MS;
  let fullDeadline = 0;
  for (const attempt of attempts) {
    const type = attempt.type ?? '';
    const isFullAttempt =
      type !== DOWNLOAD_TYPE_DIFF && type !== DOWNLOAD_TYPE_PDIFF;
    if (isFullAttempt && fullDeadline === 0) {
      // Preserve a full 10min rescue budget even when diff/pdiff exhausted
      // their own phase window.
      fullDeadline = monotonicNowMs() + DOWNLOAD_PHASE_TIMEOUT_MS;
    }
    const deadline = isFullAttempt ? fullDeadline : incrementalDeadline;
    for (const url of attempt.urls ?? []) {
      if (monotonicNowMs() >= deadline) {
        if (isFullAttempt) {
          return false;
        }
        break;
      }
      try {
        if (type === DOWNLOAD_TYPE_DIFF) {
          await runWithinDeadline(
            () => context.downloadPatchFromPpk(url, hash, originHash, deadline),
            deadline,
          );
        } else if (type === DOWNLOAD_TYPE_PDIFF) {
          await runWithinDeadline(
            () => context.downloadPatchFromPackage(url, hash, deadline),
            deadline,
          );
        } else {
          await runWithinDeadline(
            () => context.downloadFullUpdate(url, hash, deadline),
            deadline,
          );
        }
        return true;
      } catch (e) {
        logger.warn(TAG, `${type} attempt failed: ${getErrorMessage(e)}`);
        if (!isMirrorRetryable(e)) {
          // The bytes arrived but could not be applied: every mirror serves
          // the same artifact, so move on to the next strategy instead of
          // re-downloading it (update_flow_core IsMirrorRetryableCode, JS
          // client.ts isMirrorRetryableCode).
          break;
        }
      }
    }
  }
  return false;
}

function isMirrorRetryable(error: unknown): boolean {
  return !(error instanceof PushyError && error.code === ERROR_DELTA_FAILED);
}
