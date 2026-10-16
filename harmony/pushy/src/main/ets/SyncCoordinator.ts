import http from '@ohos.net.http';
import deviceInfo from '@ohos.deviceInfo';
import logger from './Logger';
import NativePatchCore from './NativePatchCore';
import type { UpdateContext } from './UpdateContext';
import { BundlePreparationRound, bundlePreparationResult } from './BundlePreparationResult';
import type { BundlePreparationResult } from './BundlePreparationResult';
import { monotonicNowMs } from './MonotonicClock';
import { PushyError, getErrorMessage } from './ErrorCodes';

// 原生冷启动检测(NATIVE_CHECKUPDATE_DESIGN §10):每进程一次,getBundleUrl
// 后延迟数秒运行,完全不依赖 app bundle——坏热更把 JS 砸挂后,下次启动仍能
// 拉到修复版。轮次本身由共享引擎驱动(cpp/update_flow_core/round_engine.h,
// 经 NativePatchCore.stepRound,NATIVE_CHECKUPDATE_DESIGN §12),本文件只
// 执行它要求的 IO。失败静默且有界:每次启动至多一轮,无重试
// 风暴,不拉黑版本。
// 鸿蒙的 debug 门控由触发点天然承担:dev 走 MetroJSBundleProvider,
// PushyFileJSBundleProvider.getBundleUrl 不会被调用。
const TAG = 'NativeSync';
// 与 Android 共用的存储键。鸿蒙不做 crash-hold(errorManager 的同步回调驱动
// 不了 ArkTS 异步网络 IO),续传 + 零延迟标记是收敛砖机的全部机制。
// <generated:storage-keys> (scripts/contract.ts; bun scripts/generate-contract.ts)
// The persisted native check config (JS syncNativeConfig or the host).
export const KEY_CONFIG = 'nativeConfig';
// Raw response cache for the JS side to reuse (§10.3), scoped to the exact
// logical request and native config that produced it.
export const KEY_RESP_CACHE = 'nativeCheckResp';
// Set when a round starts, cleared when it ends (§11.4). Residue on the
// next launch means the previous process died mid-round: that launch
// resumes immediately instead of waiting 5s.
export const KEY_ROUND_INCOMPLETE = 'nativeCheckIncomplete';
// </generated:storage-keys>
const START_DELAY_MS = 5000;

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

// 引擎的事件与命令(字段含义见 round_engine.h)。
interface RoundEvent {
  type?: string;
  now?: number;
  config?: string;
  resetGeneration?: number;
  configGeneration?: number;
  sample?: number;
  deadline?: number;
  env?: RoundEnv;
  text?: string;
  at?: number;
  installed?: boolean;
  ok?: boolean;
  code?: string;
  timedOut?: boolean;
  reason?: string;
  error?: boolean;
}

interface RoundCommand {
  type: string;
  url?: string;
  post?: boolean;
  body?: string;
  timeoutMs?: number;
  callTimeoutMs?: number;
  hash?: string;
  strategy?: string;
  originHash?: string;
  deadline?: number;
  hashInfo?: string;
  activate?: boolean;
  cache?: string;
  resetGeneration?: number;
  status?: string;
  reason?: string;
  activated?: boolean;
}

interface RoundStep {
  state: Object;
  commands: RoundCommand[];
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
  // 与引擎的 HostCancellation 同一规则:三方 C1 等价且配置代数未变。
  if (roundConfigGeneration !== context.getNativeConfigGeneration()
      || !NativePatchCore.configsEquivalent(configJson, roundConfigJson)
      || !context.isStoredNativeConfig(configJson)) {
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
  // 在任何 IO 之前采样:resetToPackagedBundle 与配置替换都会递增 reset 代数,
  // 本轮运行期间发生的 reset 必须赢过本轮的决策。
  const resetGeneration = context.getResetGeneration();
  const configGeneration = context.getNativeConfigGeneration();
  roundGeneration = resetGeneration;
  roundConfigGeneration = configGeneration;
  roundResult = bundlePreparationResult('failed', 'check_failed');
  const configJson = context.getKv(KEY_CONFIG);
  roundConfigJson = configJson;

  let event: RoundEvent = {
    type: 'start',
    config: configJson ?? '',
    resetGeneration,
    configGeneration,
    sample: Math.random(),
    deadline: 0,
  };
  let state: string | undefined = undefined;
  let marked = false;
  try {
    for (;;) {
      event.now = monotonicNowMs();
      const step = JSON.parse(
        NativePatchCore.stepRound(state, JSON.stringify(event)),
      ) as RoundStep;
      state = JSON.stringify(step.state);
      event = {};
      for (const command of step.commands) {
        if (command.type === 'markIncomplete') {
          // 从这里起本轮开始做真实工作:留下面包屑,死于轮中时下次启动零延迟续传。
          marked = true;
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
        } else if (command.type === 'finish') {
          finishRound(command);
          return;
        } else {
          event = await perform(context, launchRolledBackVersion, command, configGeneration);
        }
      }
    }
  } finally {
    if (marked) {
      try {
        await context.removeKv(KEY_ROUND_INCOMPLETE);
      } catch (e) {
        // 残留标记只意味着下次启动少等 5 秒。
        logger.warn(TAG, `cannot clear round marker: ${getErrorMessage(e)}`);
      }
    }
  }
}

// 执行引擎的一条命令,返回回应它的事件。
async function perform(
  context: UpdateContext,
  launchRolledBackVersion: string,
  command: RoundCommand,
  configGeneration: number,
): Promise<RoundEvent> {
  switch (command.type) {
    case 'collectEnv':
      return { type: 'env', env: await launchEnv(context, launchRolledBackVersion) };
    case 'http': {
      const text = await httpRequest(
        command.url ?? '',
        command.post ? command.body ?? '' : undefined,
        command.timeoutMs ?? 0,
        command.callTimeoutMs ?? 0,
      );
      return text === undefined
        ? { type: 'http' }
        : { type: 'http', text, at: Date.now() / 1000 };
    }
    case 'checkInstalled':
      return { type: 'installed', installed: context.hasDownloadedVersion(command.hash ?? '') };
    case 'download':
      return download(context, command);
    case 'commit':
      return commit(context, command, configGeneration);
    default:
      // 本适配器不认识的命令:引擎会以 internal_error 结束本轮。
      return { type: command.type };
  }
}

async function launchEnv(
  context: UpdateContext,
  launchRolledBackVersion: string,
): Promise<RoundEnv> {
  return {
    packageVersion: context.getPackageVersion(),
    // 与 JS 常量同形(无版本时为 ''),JS 才能复用这次请求的响应缓存。
    currentVersion: context.getCurrentVersion(),
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
}

// 一次下载尝试,以引擎给的 deadline 为界:超时即 timedOut,失败带错误码
// (PATCH_FAILED 由引擎决定换策略而不换镜像)。
async function download(
  context: UpdateContext,
  command: RoundCommand,
): Promise<RoundEvent> {
  const strategy = command.strategy ?? '';
  const url = command.url ?? '';
  const hash = command.hash ?? '';
  const deadline = command.deadline ?? 0;
  let timedOut = false;
  let timer = 0;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, Math.max(0, deadline - monotonicNowMs()));
  });
  // This bounds queueing, HTTP, decompression and native hpatch work from the
  // round's perspective. The serialized task may still finish later, but it
  // can no longer hold the round.
  const start = (): Promise<void> => {
    if (strategy === 'diff') {
      return context.downloadPatchFromPpk(url, hash, command.originHash ?? '', deadline);
    }
    if (strategy === 'pdiff') {
      return context.downloadPatchFromPackage(url, hash, deadline);
    }
    return context.downloadFullUpdate(url, hash, deadline);
  };
  try {
    await Promise.race([start(), expired]);
    if (timedOut) {
      logger.warn(TAG, `${strategy} attempt timed out`);
      return { type: 'download', timedOut: true };
    }
    return { type: 'download', ok: true };
  } catch (e) {
    logger.warn(TAG, `${strategy} attempt failed: ${getErrorMessage(e)}`);
    // 无错误码的失败(网络异常等)可换镜像重试。
    return e instanceof PushyError
      ? { type: 'download', ok: false, code: e.code }
      : { type: 'download', ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// 版本元信息、激活与响应缓存一次性原子提交(见 commitSyncResult)。配置替换
// 也会递增 reset 代数,提交因此被拒;配置代数用来区分是哪一种。
async function commit(
  context: UpdateContext,
  command: RoundCommand,
  configGeneration: number,
): Promise<RoundEvent> {
  try {
    const committed = await context.commitSyncResult(
      command.resetGeneration ?? -1,
      command.hash ?? '',
      command.hashInfo ?? '',
      command.activate === true,
      command.cache ?? '',
    );
    if (!committed && context.getNativeConfigGeneration() !== configGeneration) {
      return { type: 'committed', ok: false, reason: 'config_changed' };
    }
    return { type: 'committed', ok: committed };
  } catch (e) {
    logger.error(TAG, `commit failed: ${getErrorMessage(e)}`);
    return { type: 'committed', ok: false, error: true };
  }
}

function finishRound(finish: RoundCommand): void {
  const status = finish.status ?? 'failed';
  const reason = finish.reason ?? '';
  if (status === 'downloaded') {
    const hash = finish.hash ?? '';
    const activated = finish.activated === true;
    logger.info(
      TAG,
      activated
        ? `downloaded ${hash} and set for next launch`
        : `downloaded ${hash}, activation left to JS`,
    );
    roundResult = bundlePreparationResult(status, reason, hash, activated);
    return;
  }
  logger.info(TAG, `${status} (${reason})`);
  roundResult = bundlePreparationResult(status, reason);
}

// The engine's per-request bounds: timeoutMs for connect/read, callTimeoutMs
// for the whole call.
async function httpRequest(
  url: string,
  postBody: string | undefined,
  timeoutMs: number,
  callTimeoutMs: number,
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
      connectTimeout: Math.max(1, Math.floor(timeoutMs)),
      readTimeout: Math.max(1, Math.floor(timeoutMs)),
      expectDataType: http.HttpDataType.STRING,
    });
    const timeoutPromise = new Promise<http.HttpResponse>((_, reject) => {
      callTimer = setTimeout(() => {
        reject(Error(`HTTP request exceeded ${callTimeoutMs}ms`));
      }, Math.max(0, callTimeoutMs));
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
