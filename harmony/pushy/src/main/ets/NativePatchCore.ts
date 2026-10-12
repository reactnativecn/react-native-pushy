import NativeCore from 'librnpushy.so';

export const STATE_OP_SWITCH_VERSION = 1;
export const STATE_OP_MARK_SUCCESS = 2;
export const STATE_OP_ROLLBACK = 3;
export const STATE_OP_CLEAR_ROLLBACK_MARK = 5;
export const STATE_OP_RESOLVE_LAUNCH = 6;

export const ARCHIVE_PATCH_TYPE_FROM_PACKAGE = 2;
export const ARCHIVE_PATCH_TYPE_FROM_PPK = 3;

export interface StateCoreResult {
  packageVersion?: string;
  buildTime?: string;
  currentVersion?: string;
  lastVersion?: string;
  firstTime: boolean;
  firstTimeOk: boolean;
  rolledBackVersion?: string;
  changed?: boolean;
  staleVersionToDelete?: string;
  loadVersion?: string;
  didRollback?: boolean;
  consumedFirstTime?: boolean;
}

export interface CopyGroupResult {
  from: string;
  toPaths: string[];
  /** 源内容必须匹配的 CRC32(__diff.json copiesCrc);未声明时缺省 */
  expectedCrc?: number;
}

/**
 * 一次 patch 安装的原生部分(cpp/patch_core/archive_patch_core.h
 * ApplyArchivePatch):校验条目、解析并校验 __diff.json、重建 bundle;
 * hostCopiesResources 为 false 时同时完成拷贝/删除/合并。
 */
export interface ArchivePatchRequest {
  archiveType: number;
  /** staging 目录里解压出的条目名 */
  entryNames: string[];
  /** __diff.json 原文;归档里没有时为空串 */
  manifestJson: string;
  bundleDeltaEntry: string;
  /** 从拷贝源开头剥掉的前缀(包内 rawfile 路径) */
  copySourcePrefix?: string;
  sourceRoot: string;
  targetRoot: string;
  originBundlePath: string;
  bundleDeltaPath: string;
  bundleOutputPath: string;
  /** 资源不在 sourceRoot 下(rawfile):只重建 bundle,拷贝分组交回调用方 */
  hostCopiesResources?: boolean;
}

interface NativePatchCoreBindings {
  syncStateWithBinaryVersion(
    packageVersion: string,
    buildTime: string,
    state: StateCoreResult,
  ): StateCoreResult;
  runStateCore(
    operation: number,
    state: StateCoreResult,
    stringArg?: string,
    flagA?: boolean,
    flagB?: boolean,
  ): StateCoreResult;
  /** 工作线程执行;resolve 为调用方仍需完成的拷贝(hostCopiesResources 之外为空) */
  applyArchiveDelta(request: ArchivePatchRequest): Promise<CopyGroupResult[]>;
  /**
   * 删除 rootDir 下超过 maxAgeDays 且名字不在 keepNames 里的条目(native
   * 工作线程)。keepNames 必须包含所有可能仍在使用的版本:持久化的
   * current/last 以及本进程实际启动的版本。
   */
  cleanupOldEntries(
    rootDir: string,
    keepNames: string[],
    maxAgeDays: number,
  ): Promise<void>;
  // 文件流式 SHA-256(小写 hex),在 libuv 工作线程计算;文件不可读时 reject。
  sha256HexFileAsync(path: string): Promise<string>;
  // fd 上 [offset, offset + length) 区间的 SHA-256(小写 hex),工作线程
  // pread 流式计算(内嵌 bundle 走 resourceManager.getRawFd)。fd 由调用方
  // 持有,promise 落定前不得关闭;读失败/提前 EOF 时 reject。
  sha256HexRawFdAsync(fd: number, offset: number, length: number): Promise<string>;
  /** CRC32(zip/zlib 多项式)。pdiff 拷贝前与 copiesCrc 比对用 */
  crc32(data: Uint8Array | ArrayBuffer): number;
  /** 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道) */
  getSupportedDiffVersion(): number;

  // 更新流程决策层(cpp/update_flow_core,NATIVE_CHECKUPDATE_DESIGN §10):
  // JSON 字符串进出,与决策层自身的边界一致。返回 undefined = 输入未通过
  // 解析,编排器跳过本轮检测。
  buildRequestBody(inputJson: string): string | undefined;
  orderEndpointCandidates(
    endpointsJson: string,
    randomSample: number,
  ): string | undefined;
  handleResponse(
    responseText: string,
    identityJson: string,
    afterDownload: string,
  ): string | undefined;
  // 响应 schema 门槛(update_flow_core::IsValidResponse):200 但只带
  // `{"error":...}` 的节点算失败,不得阻止继续 fallback。
  isValidResponse(responseText: string): boolean;

  // 持久化的原生配置(cpp/update_flow_core/native_config.h,与 Android/iOS
  // 共用)。undefined 视同空串:缺省配置。
  /** C1 配置等价:同一配置的不同序列化。任一缺省即不等价。 */
  configsEquivalent(a: string | undefined, b: string | undefined): boolean;
  /**
   * 轮次门槛:可运行时为 {"appKey": 去空白后的值},否则
   * {"status": "skipped" | "failed", "reason": ...}。
   */
  runnableConfig(configJson: string | undefined): string;
  /**
   * 校验宿主 configure() 的选项(JSON 对象文本),返回要持久化的配置;
   * 不合法时抛出 Error("Invalid native configuration: ...")。
   */
  normalizeConfiguration(optionsJson: string | undefined): string;
}

export default NativeCore as unknown as NativePatchCoreBindings;
