import NativePatchCore from './NativePatchCore';
import {
  ERROR_DELTA_FAILED,
  ERROR_SWITCH_VERSION_FAILED,
  createPushyError,
  getErrorMessage,
} from './ErrorCodes';

// 两阶段安装的完成记录(cpp/patch_core/install_record.h,三端共用的唯一
// 实现):解压/打补丁全在 staging 目录里进行,最后写入记录,再一次 rename 成
// 版本目录;激活前重新校验 bundle 摘要。这里只拼路径、把原生结果映射成
// 稳定错误码。
// STAGING_SUFFIX 镜像 kStagingSuffix(scripts/check-constant-parity.js 断言)。
export const STAGING_SUFFIX = '.staging';
// 归档不得携带任何 `.pushy-` 前缀的条目(任意深度):这些名字保留给 SDK 自己
// 写的记录,与 Android 的规则一致。
export const RESERVED_ENTRY_PREFIX = '.pushy-';
export const HARMONY_BUNDLE_FILE_NAME = 'bundle.harmony.js';

export function stagingDirectoryFor(versionDir: string): string {
  return `${versionDir}${STAGING_SUFFIX}`;
}

export function isReservedEntryName(name: string): boolean {
  return name.startsWith(RESERVED_ENTRY_PREFIX);
}

/**
 * 在 native 工作线程计算 staging 里 bundle 的摘要并原子写入完成记录
 * (schema 1 的 bundleSha256 必填:算不出摘要就安装失败)。失败 = PATCH_FAILED。
 */
export async function sealInstallRecord(
  stagingDir: string,
  versionHash: string,
  artifactSha256: string,
): Promise<void> {
  try {
    await NativePatchCore.sealInstallRecord(
      stagingDir,
      versionHash,
      HARMONY_BUNDLE_FILE_NAME,
      artifactSha256,
    );
  } catch (e) {
    throw createPushyError(ERROR_DELTA_FAILED, getErrorMessage(e));
  }
}

/** staging rename 成版本目录(调用方先删掉已有的版本目录)。失败 = PATCH_FAILED。 */
export async function promoteStaging(
  stagingDir: string,
  versionDir: string,
): Promise<void> {
  try {
    await NativePatchCore.promoteStaging(stagingDir, versionDir);
  } catch (e) {
    throw createPushyError(ERROR_DELTA_FAILED, getErrorMessage(e));
  }
}

/** 存在性判定(启动/去重路径,不算摘要)。 */
export function isInstallComplete(versionDir: string, versionHash: string): boolean {
  return NativePatchCore.isInstallComplete(
    versionDir,
    versionHash,
    HARMONY_BUNDLE_FILE_NAME,
  );
}

/** 记录里的 bundleSha256(崩溃归因);没有时为空串。 */
export function recordedBundleSha256(versionDir: string): string {
  return NativePatchCore.recordedBundleSha256(versionDir);
}

/**
 * 激活前校验:bundle 在盘上,且记录的摘要与盘上字节一致(整包几十 MB,在
 * native 工作线程算)。无记录文件的目录只有是 current/last(grandfathered,
 * 标记机制之前就激活过)时放行。不通过抛 SWITCH_VERSION_FAILED。
 */
export async function verifyInstallForActivation(
  versionDir: string,
  versionHash: string,
  grandfathered: boolean,
): Promise<void> {
  try {
    await NativePatchCore.checkActivation(
      versionDir,
      versionHash,
      HARMONY_BUNDLE_FILE_NAME,
      grandfathered,
    );
  } catch (e) {
    throw createPushyError(ERROR_SWITCH_VERSION_FAILED, getErrorMessage(e));
  }
}
