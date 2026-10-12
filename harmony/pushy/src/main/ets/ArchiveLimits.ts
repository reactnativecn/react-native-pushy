import fileIo from '@ohos.file.fs';
import statvfs from '@ohos.file.statvfs';
import {
  ERROR_FILE_OPERATION_FAILED,
  ERROR_DELTA_FAILED,
  createPushyError,
} from './ErrorCodes';
import { isReservedEntryName } from './InstallRecord';

// ArkTS mirror of cpp/patch_core/archive_limits.h — keep in sync by hand
// (harmony/pushy/src/test/check-constant-parity.js asserts the values match).
// 损坏或恶意更新包的伤害上限:最多耗费有限的磁盘/内存/时间,绝不撑爆磁盘。
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 2048 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRIES = 20000;
export const MAX_COMPRESSION_RATIO = 100;
export const RATIO_CHECK_MIN_BYTES = 1 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const FREE_DISK_MARGIN_BYTES = 64 * 1024 * 1024;
export const UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES = 8 * 1024 * 1024;

/**
 * 解压前的总量校验(zlib.getOriginalSize 给出的归档解压后总字节数)。
 *
 * 与 archive_limits.h 的偏差(有意为之,无法消除):头文件的压缩比上限是
 * **逐条**的(单条解压量 > RATIO_CHECK_MIN_BYTES 时才查),但鸿蒙的
 * @kit.BasicServicesKit zlib 只提供整包解压量(getOriginalSize)与整包
 * 解压(decompressFile),拿不到任何条目的压缩/解压尺寸,也没有逐条钩子。
 * 因此这里只能按整包近似:总解压量超过上限、或(总量大于
 * RATIO_CHECK_MIN_BYTES 时)总压缩比超过 MAX_COMPRESSION_RATIO 即拒绝——
 * 20MB 归档 100:1 的 2GB 载荷在解压前就被挡下,而不是先解出来再量。
 * 两个方向的差异:
 *  - 更松:单条高压缩比条目被同包大量不可压缩数据"稀释"时整包比可能不超限
 *    (其总量仍受 MAX_TOTAL_UNCOMPRESSED_BYTES 与解压后的逐条
 *    MAX_ENTRY_BYTES 约束,伤害有界);
 *  - 更严:大量各自 < RATIO_CHECK_MIN_BYTES 的高压缩比小文件,逐条不查,
 *    但累加后整包比超限会被拒绝(真实更新包不会出现 100:1 的整包比)。
 * 解压后 measureExtractedDirectory 再逐条核对条目数/单条大小/总字节数。
 */
export function checkUncompressedSize(
  archiveBytes: number,
  uncompressedBytes: number,
): void {
  if (uncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw createPushyError(
      ERROR_DELTA_FAILED,
      `archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes ` +
        `(${uncompressedBytes})`,
    );
  }
  if (
    uncompressedBytes > RATIO_CHECK_MIN_BYTES &&
    archiveBytes > 0 &&
    uncompressedBytes > archiveBytes * MAX_COMPRESSION_RATIO
  ) {
    throw createPushyError(
      ERROR_DELTA_FAILED,
      `archive compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1 ` +
        `(${uncompressedBytes}/${archiveBytes})`,
    );
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

export interface FreeSpaceProbePlan {
  /** 本次写入前是否需要探测可用空间。 */
  probe: boolean;
  /** 探测时要求的字节数(不含 FREE_DISK_MARGIN_BYTES)。 */
  reserve: number;
  /** 计划后的"已预留到"位置(相对本次响应体起点)。 */
  reservedUntil: number;
}

/**
 * 未知长度下载(分块/编码响应体)的磁盘探测计划:响应到达时只能预留安全
 * 余量,所以任何会写过已预留位置的写入之前都要探测,每次至少预留接下来的
 * UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES(单个 chunk 更大时按 chunk 算)——
 * 任何写入都吃不到余量。已知总长时由响应到达时的一次性检查覆盖,不探测。
 * writtenBefore 是本 chunk 之前已收到的字节数(相对本次响应体)。
 */
export function planUnknownLengthFreeSpaceProbe(
  knownTotal: number,
  writtenBefore: number,
  chunkBytes: number,
  reservedUntil: number,
): FreeSpaceProbePlan {
  const reserve = Math.max(UNKNOWN_LENGTH_FREE_SPACE_PROBE_BYTES, chunkBytes);
  if (knownTotal > 0 || writtenBefore + chunkBytes <= reservedUntil) {
    return { probe: false, reserve, reservedUntil };
  }
  return { probe: true, reserve, reservedUntil: writtenBefore + reserve };
}

/**
 * 目标所在文件系统必须还能再写 bytesToWrite + 安全余量。取不到可用空间
 * (返回 0/异常)视为未知,放行。
 */
export async function ensureFreeSpace(
  target: string,
  bytesToWrite: number,
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
      ERROR_FILE_OPERATION_FAILED,
      `insufficient disk space: need ${needed} bytes, have ${free}`,
    );
  }
}

export interface DirectoryMeasure {
  entries: number;
  bytes: number;
}

/**
 * 递归统计目录里的条目数与总字节数;两者任一超过上限立即抛错(不必扫完)。
 * 同一趟遍历里拒绝任意深度的 `.pushy-` 保留条目(完成记录只能由 SDK 写)。
 */
export async function measureExtractedDirectory(
  directory: string,
  acc: DirectoryMeasure = { entries: 0, bytes: 0 },
): Promise<DirectoryMeasure> {
  const names = (await fileIo.listFile(directory)).filter(
    name => name !== '.' && name !== '..',
  );
  for (const name of names) {
    if (isReservedEntryName(name)) {
      throw createPushyError(
        ERROR_DELTA_FAILED,
        `archive contains reserved entry ${name}`,
      );
    }
    const path = `${directory}/${name}`;
    const stat = await fileIo.stat(path);
    acc.entries += 1;
    if (acc.entries > MAX_ENTRIES) {
      throw createPushyError(
        ERROR_DELTA_FAILED,
        `archive has too many entries (> ${MAX_ENTRIES})`,
      );
    }
    if (stat.isDirectory()) {
      await measureExtractedDirectory(path, acc);
      continue;
    }
    if (stat.size > MAX_ENTRY_BYTES) {
      throw createPushyError(
        ERROR_DELTA_FAILED,
        `archive entry too large: ${name} (${stat.size} bytes)`,
      );
    }
    acc.bytes += stat.size;
    if (acc.bytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw createPushyError(
        ERROR_DELTA_FAILED,
        `archive expands beyond ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes`,
      );
    }
  }
  return acc;
}
