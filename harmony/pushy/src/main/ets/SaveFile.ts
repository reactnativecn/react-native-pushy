import resourceManager from '@ohos.resourceManager';
import fs from '@ohos.file.fs';
import logger from './Logger';
import { getErrorMessage } from './ErrorCodes';

const TAG = 'SaveFile';
// 每次 read/write 都是一次工作线程往返:块大一些,几 MB 的 bundle 只需
// 十几次往返;内存上限仍是一个块。
const COPY_BUFFER_SIZE = 512 * 1024;

// resourceManager 按文件名跟踪 rawfile descriptor(closeRawFd 只收名字):
// 同名的 getRawFd/closeRawFd 若交错,一方的 close 可能在另一方读到一半时
// 关掉它的 fd。同名访问按到达顺序串行(不同名互不影响)。
const rawFdChains = new Map<string, Promise<void>>();

/**
 * 打开 rawfile descriptor 交给 job,job 结束(无论成败)后关闭。同名串行。
 * descriptor 指向 HAP 内 [offset, offset + length) 区间,job 只能按 offset
 * 定位读取。
 */
export async function withRawFd<T>(
  manager: resourceManager.ResourceManager,
  name: string,
  job: (descriptor: resourceManager.RawFileDescriptor) => Promise<T>,
): Promise<T> {
  const previous = rawFdChains.get(name) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  rawFdChains.set(name, tail);
  try {
    await previous;
    const descriptor = await manager.getRawFd(name);
    try {
      return await job(descriptor);
    } finally {
      try {
        await manager.closeRawFd(name);
      } catch (closeError) {
        logger.error(
          TAG,
          `Failed to close raw fd for ${name}: ${getErrorMessage(closeError)}`,
        );
      }
    }
  } finally {
    release();
    if (rawFdChains.get(name) === tail) {
      rawFdChains.delete(name);
    }
  }
}

/** 把 buffer 的前 length 字节完整写入 fd(处理短写)。 */
export async function writeFully(
  fd: number,
  buffer: ArrayBuffer,
  length: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const chunk = written === 0 ? buffer : buffer.slice(written, length);
    const count = await fs.write(fd, chunk, { length: length - written });
    if (count <= 0) {
      throw new Error(`Short write: ${written}/${length} bytes`);
    }
    written += count;
  }
}

/** 文件存在则删除(删除失败照常抛出)。 */
export async function unlinkIfExists(path: string): Promise<void> {
  if (fs.accessSync(path)) {
    await fs.unlink(path);
  }
}

/**
 * 把 rawfile descriptor 指向的区间异步拷贝到沙箱文件(覆盖)。全程异步
 * fileIo:调用方在 UI 线程(TurboModule),同步 IO 会冻结界面。读到预期
 * 长度之前遇到 EOF 视为错误。
 */
export async function saveFileToSandbox(
  from: resourceManager.RawFileDescriptor,
  toPath: string,
): Promise<void> {
  const to = await fs.open(
    toPath,
    fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC,
  );
  const buffer = new ArrayBuffer(
    Math.max(1, Math.min(COPY_BUFFER_SIZE, from.length)),
  );
  let position = from.offset;
  let remaining = from.length;

  try {
    while (remaining > 0) {
      const readLength = await fs.read(from.fd, buffer, {
        offset: position,
        length: Math.min(buffer.byteLength, remaining),
      });
      if (readLength <= 0) {
        throw new Error(`Unexpected EOF while copying resource to ${toPath}`);
      }
      await writeFully(to.fd, buffer, readLength);
      position += readLength;
      remaining -= readLength;
    }
  } finally {
    await fs.close(to);
  }
}
