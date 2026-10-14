import fileIo from '@ohos.file.fs';
import statvfs from '@ohos.file.statvfs';
import {
  ERROR_DELTA_FAILED,
  createPushyError,
  getErrorMessage,
} from './ErrorCodes';
import NativePatchCore from './NativePatchCore';

// 解压资源上限的计数规则(条目数、单条/总解压量、压缩比、保留名、符号链接、
// 未知长度下载的磁盘探测计划)只在 cpp/patch_core/archive_limits.h 里实现,
// 三端共用(这里经 NAPI)。下面只镜像本端仍需自己比较的常量,
// scripts/check-constant-parity.js 断言与头文件一致。
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const FREE_DISK_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * 解压前的整包校验(zlib.getOriginalSize 给出的归档解压后总字节数):总解压
 * 量上限与整包压缩比(archive_limits::CheckUncompressedSize)。鸿蒙的 zlib
 * 只提供整包解压量与整包解压,拿不到条目的压缩尺寸,逐条压缩比无从查起;
 * 20MB 归档 100:1 的 2GB 载荷在解压前就被挡下,解压后 checkExtractedDirectory
 * 再逐条核对。
 */
export function checkUncompressedSize(
  archiveBytes: number,
  uncompressedBytes: number,
): void {
  const reason = NativePatchCore.checkUncompressedSize(
    archiveBytes,
    uncompressedBytes,
  );
  if (reason !== undefined) {
    throw createPushyError(ERROR_DELTA_FAILED, reason);
  }
}

// 解压量取不到时拒绝的专属错误细节:与"超限"拒绝区分开,日志与遥测里一眼
// 可辨(典型原因:设备 zlib 不认该归档格式/归档损坏)。不做任何放行回退。
export const ORIGINAL_SIZE_UNAVAILABLE = 'archive expansion size unavailable';

/**
 * zlib.getOriginalSize 的结果校验。failure 非 undefined 表示调用本身抛错
 * (其消息);否则校验返回值必须是有限非负数。任何一种都拒绝归档:不知道
 * 展开量就放行,等于允许一个 20MB 的归档在解压后的统计跑到之前先写满磁盘。
 */
export function checkOriginalSize(
  size: number | undefined,
  failure?: string,
): number {
  if (failure !== undefined) {
    throw createPushyError(
      ERROR_DELTA_FAILED,
      `${ORIGINAL_SIZE_UNAVAILABLE}: getOriginalSize failed: ${failure}`,
    );
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw createPushyError(
      ERROR_DELTA_FAILED,
      `${ORIGINAL_SIZE_UNAVAILABLE}: getOriginalSize returned ${String(size)}`,
    );
  }
  return size;
}

/**
 * 目标所在文件系统必须还能再写 bytesToWrite + 安全余量。取不到可用空间
 * (返回 0/异常)视为未知,放行。空间不足以 `code` 失败:错误码按阶段归类,
 * 与 Android/iOS 一致——下载阶段 DOWNLOAD_FAILED,解压阶段 PATCH_FAILED。
 * 换镜像的判定(IsMirrorRetryableCode)与补丁健康度遥测都按这个码聚合。
 */
export async function ensureFreeSpace(
  target: string,
  bytesToWrite: number,
  code: string,
): Promise<void> {
  let probe = target;
  while (probe.length > 1 && !fileIo.accessSync(probe)) {
    const slash = probe.lastIndexOf('/');
    if (slash <= 0) {
      return;
    }
    probe = probe.substring(0, slash);
  }
  let free = 0;
  try {
    free = await statvfs.getFreeSize(probe);
  } catch (e) {
    return;
  }
  if (free <= 0) {
    return;
  }
  const needed = Math.max(0, bytesToWrite) + FREE_DISK_MARGIN_BYTES;
  if (free < needed) {
    throw createPushyError(
      code,
      `insufficient disk space: need ${needed} bytes, have ${free}`,
    );
  }
}

/**
 * 解压后在 native 工作线程逐条核对刚解压的目录(archive_limits::
 * CheckExtractedDirectory):条目数、单条大小、总字节数与整包压缩比,拒绝
 * 任意深度的 `.pushy-` 保留条目(完成记录只能由 SDK 写)与符号链接。
 */
export async function checkExtractedDirectory(
  directory: string,
  archiveBytes: number,
): Promise<void> {
  try {
    await NativePatchCore.checkExtractedDirectory(directory, archiveBytes);
  } catch (e) {
    throw createPushyError(ERROR_DELTA_FAILED, getErrorMessage(e));
  }
}
