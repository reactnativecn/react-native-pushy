import NativeCore from 'librnpushy.so';

// <generated:state-operations> (scripts/contract.ts; bun scripts/generate-contract.ts)
export const STATE_OP_SWITCH_VERSION = 1;
export const STATE_OP_MARK_SUCCESS = 2;
export const STATE_OP_ROLLBACK = 3;
// 4 (ClearFirstTime) has no caller on this side.
export const STATE_OP_CLEAR_ROLLBACK_MARK = 5;
export const STATE_OP_RESOLVE_LAUNCH = 6;
// </generated:state-operations>

// <generated:archive-patch-types> (scripts/contract.ts; bun scripts/generate-contract.ts)
export const ARCHIVE_PATCH_TYPE_FULL = 1;
export const ARCHIVE_PATCH_TYPE_FROM_PACKAGE = 2;
export const ARCHIVE_PATCH_TYPE_FROM_PPK = 3;
// </generated:archive-patch-types>

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

export interface FreeSpaceProbePlan {
  /** 本次写入前是否需要探测可用空间。 */
  probe: boolean;
  /** 探测时要求的字节数(不含 FREE_DISK_MARGIN_BYTES)。 */
  reserve: number;
  /** 计划后的"已预留到"位置(相对本次响应体起点)。 */
  reservedUntil: number;
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
  // 完成记录(cpp/patch_core/install_record.h,与 Android/iOS 共用)。
  /** 存在性判定(启动/去重路径,不算摘要):bundle 在盘上且记录指向本版本 */
  isInstallComplete(
    versionDir: string,
    versionHash: string,
    bundleFileName: string,
  ): boolean;
  /** 记录里的 bundleSha256(崩溃归因);没有时为空串 */
  recordedBundleSha256(versionDir: string): string;
  /** 工作线程上计算 staging 里 bundle 的摘要并原子写入完成记录 */
  sealInstallRecord(
    stagingDir: string,
    versionHash: string,
    bundleFileName: string,
    artifactSha256: string,
  ): Promise<void>;
  /** 把已写完记录的 staging 目录 rename 成版本目录(调用方先删掉旧目录) */
  promoteStaging(stagingDir: string, versionDir: string): Promise<void>;
  /**
   * 激活前校验(工作线程重算 bundle 摘要);不可激活时以原因 reject。
   * grandfathered = 该版本是持久化的 current/last。
   */
  checkActivation(
    versionDir: string,
    versionHash: string,
    bundleFileName: string,
    grandfathered: boolean,
  ): Promise<void>;
  // 解压资源上限(cpp/patch_core/archive_limits.h,与 Android/iOS 共用)。
  /** 整包解压量与整包压缩比;超限时返回原因,否则 undefined */
  checkUncompressedSize(
    archiveBytes: number,
    uncompressedBytes: number,
  ): string | undefined;
  /** 工作线程遍历刚解压的目录(不跟随符号链接),超限/保留名/符号链接时以原因 reject */
  checkExtractedDirectory(directory: string, archiveBytes: number): Promise<void>;
  /**
   * 未知长度下载每个 chunk 写入前的磁盘探测计划。writtenBefore 是本次响应体
   * 在该 chunk 之前已收到的字节数;knownTotal > 0 时从不探测。
   */
  planFreeSpaceProbe(
    knownTotal: number,
    writtenBefore: number,
    chunkBytes: number,
    reservedUntil: number,
  ): FreeSpaceProbePlan;
  /** CRC32(zip/zlib 多项式)。pdiff 拷贝前与 copiesCrc 比对用 */
  crc32(data: Uint8Array | ArrayBuffer): number;
  /** 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道) */
  getSupportedDiffVersion(): number;

  // 原生冷启动轮次(cpp/update_flow_core/native_round.h,与 Android/iOS 共用):
  // JSON 字符串进出。返回 undefined = 内核拒收了输入,本轮失败。
  // envJson 描述本次启动(字段见 native_round.h)。
  /** {"body": 请求体文本, "query": 首个查询状态};配置不可运行时 undefined */
  prepareRound(
    configJson: string,
    envJson: string,
    randomSample: number,
  ): string | undefined;
  /**
   * 下一步查询状态:带 "url"(及 "post")= 发这个请求后再调;"found" = 刚传入
   * 的文本就是有效响应;都没有 = 查询结束。responseText 为 undefined 表示请求
   * 失败或尚未发出。
   */
  nextQueryStep(
    stateJson: string,
    responseText: string | undefined,
  ): string | undefined;
  /**
   * 轮次驱动的一步(cpp/update_flow_core/round_engine.h):返回
   * {"state", "commands"};stateJson 为 undefined 表示开始新一轮。
   */
  stepRound(stateJson: string | undefined, eventJson: string): string;
  /** 决策(已按本机规划的 attempts)、要持久化的 hashInfo 与响应缓存文本 */
  handleResponse(
    responseText: string,
    configJson: string,
    envJson: string,
    requestBody: string,
    responseAtSeconds: number,
  ): string | undefined;

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

  // 断点续传决策(cpp/patch_core/resume_plan.h,与 Android/iOS 共用),
  // 返回 JSON 文本;IO 留在 DownloadTask.ts。sidecar 为 "" 表示没有。
  /** 请求前:complete / resume(offset + headers) / fresh。 */
  resumePlanRequest(sidecar: string, url: string, partialSize: number): string;
  /** 响应到达后:complete / restart / httpError / write(append, base, total, encoded, persistSidecar)。 */
  resumeClassifyResponse(
    status: number,
    resumeOffset: number,
    contentRange: string,
    contentEncoding: string,
    contentLength: number,
    sidecar: string,
    url: string,
    partialSize: number,
  ): string;
  /** 要写入的 sidecar 文本:本次响应的验证器,缺失时沿用上一份;total>0 才记。 */
  resumeSidecar(
    url: string,
    etag: string,
    lastModified: string,
    previousSidecar: string,
    total: number,
  ): string;

  // 落盘布局迁移(cpp/patch_core/stored_items.h,与 Android/iOS 共用):
  // 旧/新存储的扁平键值数组 [k, v, k, v, ...],返回计划 JSON
  // {schemaVersion, migrated, puts, removes};未知布局返回 'null'。IO 在 StoreSchema.ts。
  migrateStoredItems(legacyLayout: number, legacy: string[], current: string[]): string;
}

export default NativeCore as unknown as NativePatchCoreBindings;
