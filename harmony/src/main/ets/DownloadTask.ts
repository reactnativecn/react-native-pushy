import http from '@ohos.net.http';
import fileIo from '@ohos.file.fs';
import util from '@ohos.util';
import common from '@ohos.app.ability.common';
import { BusinessError } from '@kit.BasicServicesKit';
import { buffer } from '@kit.ArkTS';
import zip from '@ohos.zlib';
import { EventHub } from './EventHub';
import { DownloadTaskParams } from './DownloadTaskParams';
import Pushy from 'librnupdate.so';

interface ZipEntry {
  filename: string;
  content: ArrayBuffer;
}

interface ZipFile {
  entries: ZipEntry[];
}

export class DownloadTask {
  private context: common.Context;
  private hash: string;
  private readonly DOWNLOAD_CHUNK_SIZE = 4096;
  private eventHub: EventHub;

  constructor(context: common.Context) {
    this.context = context;
    this.eventHub = EventHub.getInstance();
  }

  private async removeDirectory(path: string): Promise<void> {
    try {
      const res = fileIo.accessSync(path);
      if (res) {
        const stat = await fileIo.stat(path);
        if (stat.isDirectory()) {
          const files = await fileIo.listFile(path);
          for (const file of files) {
            if (file === '.' || file === '..') continue;
            await this.removeDirectory(`${path}/${file}`);
          }
          await fileIo.rmdir(path);
        } else {
          await fileIo.unlink(path);
        }
      }
    } catch (error) {
      console.error('Failed to delete directory:', error);
      throw error;
    }
  }

  private async downloadFile(params: DownloadTaskParams): Promise<void> {
    const httpRequest = http.createHttp();
    this.hash = params.hash;

    try {
      try {
        const exists = fileIo.accessSync(params.targetFile);
        if (exists) {
          await fileIo.unlink(params.targetFile);
        }else{
          const targetDir = params.targetFile.substring(
            0,
            params.targetFile.lastIndexOf('/'),
          );
          await fileIo.mkdir(targetDir);
        }
      } catch (error) {
      }

      const response = await httpRequest.request(params.url, {
        method: http.RequestMethod.GET,
        readTimeout: 60000,
        connectTimeout: 60000,
        header: {
          'Content-Type': 'application/octet-stream',
        },
      });

      if (response.responseCode > 299) {
        throw new Error(`Server error: ${response.responseCode}`);
      }

      const contentLength = parseInt(response.header['Content-Length'] || '0');
      const writer = await fileIo.open(
        params.targetFile,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE,
      );
      let received = 0;
      const data = response.result as ArrayBuffer;
      const chunks = Math.ceil(data.byteLength / this.DOWNLOAD_CHUNK_SIZE);
      console.log('开始写入文件，总大小:', data.byteLength);
      for (let i = 0; i < chunks; i++) {
        const start = i * this.DOWNLOAD_CHUNK_SIZE;
        const end = Math.min(start + this.DOWNLOAD_CHUNK_SIZE, data.byteLength);
        const chunk = data.slice(start, end);

        await fileIo.write(writer.fd, chunk);
        received += chunk.byteLength;

        this.onProgressUpdate(received, contentLength);
      }
      await fileIo.close(writer);
      const stat = await fileIo.stat(params.targetFile);
      const fileSize = stat.size;
      console.log('😁下载成功');
    } catch (error) {
      console.error('Download failed:', error);
      throw error;
    } finally {
      httpRequest.destroy();
    }
  }

  private onProgressUpdate(received: number, total: number): void {
    this.eventHub.emit('downloadProgress', {
      received,
      total,
      hash: this.hash,
    });
  }

  private async copyFile(from: string, to: string): Promise<void> {
    let reader;
    let writer;
    try {
      reader = fileIo.openSync(from, fileIo.OpenMode.READ_ONLY);
      writer = fileIo.openSync(
        to,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
      );
      const arrayBuffer = new ArrayBuffer(4096);
      let bytesRead: number;
      do {
        bytesRead = await fileIo
          .read(reader.fd, arrayBuffer)
          .catch((err: BusinessError) => {
            throw new Error(
              `Error reading file: ${err.message}, code: ${err.code}`,
            );
          });
        if (bytesRead > 0) {
          const buf = buffer.from(arrayBuffer, 0, bytesRead);
          await fileIo
            .write(writer.fd, buf.buffer, {
              offset: 0,
              length: bytesRead,
            })
            .catch((err: BusinessError) => {
              throw new Error(
                `Error writing file: ${err.message}, code: ${err.code}`,
              );
            });
        }
      } while (bytesRead > 0);
      console.info('File copied successfully');
    } catch (error) {
      console.error('Copy file failed:', error);
      throw error;
    } finally {
      if (reader !== undefined) {
        fileIo.closeSync(reader);
      }
      if (writer !== undefined) {
        fileIo.closeSync(writer);
      }
    }
  }

  private async doFullPatch(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

    // 解压文件
    try {
      await zip.decompressFile(params.targetFile, params.unzipDirectory);
    } catch (error) {
      console.error('Unzip failed:', error);
      throw error;
    }
  }

  private async processUnzippedFiles(directory: string): Promise<ZipFile> {
    const entries: ZipEntry[] = [];
    try {
      const files = await fileIo.listFile(directory);
      for (const file of files) {
        if (file === '.' || file === '..') continue;

        const filePath = `${directory}/${file}`;
        const stat = await fileIo.stat(filePath);

        if (!stat.isDirectory()) {
          const reader = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
          const fileSize = stat.size;
          const content = new ArrayBuffer(fileSize);

          try {
            await fileIo.read(reader.fd, content);
            entries.push({
              filename: file,
              content: content,
            });
          } finally {
            await fileIo.close(reader);
          }
        }
      }

      return { entries };
    } catch (error) {
      console.error('Failed to process unzipped files:', error);
      throw error;
    }
  }

  private async doPatchFromApp(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

    let foundDiff = false;
    let foundBundlePatch = false;
    const copyList: Map<string, Array<any>> = new Map();
    await zip.decompressFile(params.targetFile, params.unzipDirectory);
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    for (const entry of zipFile.entries) {
      const fn = entry.filename;

      if (fn === '__diff.json') {
        foundDiff = true;
        let jsonContent = '';
        const bufferArray = new Uint8Array(entry.content);
        for (let i = 0; i < bufferArray.length; i++) {
          jsonContent += String.fromCharCode(bufferArray[i]);
        }
        const obj = JSON.parse(jsonContent);

        const copies = obj.copies;
        for (const to in copies) {
          let from = copies[to];
          if (from === '') {
            from = to;
          }

          if (!copyList.has(from)) {
            copyList.set(from, []);
          }

          const target = copyList.get(from);
          if (target) {
            const toFile = `${params.unzipDirectory}/${to}`;
            target.push(toFile);
          }
        }
        continue;
      }
      if (fn === 'bundle.harmony.js.patch') {
        foundBundlePatch = true;
        try {
          const resourceManager = this.context.resourceManager;
          const originContent = await resourceManager.getRawFileContent(
            'bundle.harmony.js',
          );
          const patched = await Pushy.hdiffPatch(
            new Uint8Array(originContent.buffer),
            new Uint8Array(entry.content),
          );
          console.log('😁patched', patched);
          const outputFile = `${params.unzipDirectory}/bundle.harmony.js`;
          const writer = await fileIo.open(
            outputFile,
            fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY,
          );
          const chunkSize = 4096;
          let bytesWritten = 0;
          const totalLength = patched.byteLength;

          while (bytesWritten < totalLength) {
            const chunk = patched.slice(bytesWritten, bytesWritten + chunkSize);
            await fileIo.write(writer.fd, chunk);
            bytesWritten += chunk.byteLength;
          }
          await fileIo.close(writer);
          console.log('😁outputFile', outputFile);
          continue;
        } catch (error) {
          console.error('Failed to process bundle patch:', error);
          throw error;
        }
      }

      // await zip.decompressFile(entry.filename, params.unzipDirectory);
    }

    if (!foundDiff) {
      throw new Error('diff.json not found');
    }
    if (!foundBundlePatch) {
      throw new Error('bundle patch not found');
    }
    // await this.copyFromResource(copyList);
  }

  private async doPatchFromPpk(params: DownloadTaskParams): Promise<void> {
    await this.downloadFile(params);
    await this.removeDirectory(params.unzipDirectory);
    await fileIo.mkdir(params.unzipDirectory);

    let foundDiff = false;
    let foundBundlePatch = false;
    const copyList: Map<string, Array<any>> = new Map();
    await zip.decompressFile(params.targetFile, params.unzipDirectory);
    const zipFile = await this.processUnzippedFiles(params.unzipDirectory);
    for (const entry of zipFile.entries) {
      const fn = entry.filename;

      if (fn === '__diff.json') {
        foundDiff = true;
        let jsonContent = '';
        const bufferArray = new Uint8Array(entry.content);
        for (let i = 0; i < bufferArray.length; i++) {
          jsonContent += String.fromCharCode(bufferArray[i]);
        }
        const obj = JSON.parse(jsonContent);

        const copies = obj.copies;
        for (const to in copies) {
          let from = copies[to];
          if (from === '') {
            from = to;
          }

          if (!copyList.has(from)) {
            copyList.set(from, []);
          }

          const target = copyList.get(from);
          if (target) {
            const toFile = `${params.unzipDirectory}/${to}`;
            target.push(toFile);
          }
        }
        continue;
      }
      if (fn === 'bundle.harmony.js.patch') {
        foundBundlePatch = true;
        const filePath = params.originDirectory + '/bundle.harmony.js';
        const res = fileIo.accessSync(filePath);
        console.log('😁filePath', filePath, res);
        if (res) {
          const stat = await fileIo.stat(filePath);
          const reader = await fileIo.open(filePath, fileIo.OpenMode.READ_ONLY);
          const fileSize = stat.size;
          const originContent = new ArrayBuffer(fileSize);
          try {
            await fileIo.read(reader.fd, originContent);
            const patched = await Pushy.hdiffPatch(
              new Uint8Array(originContent),
              new Uint8Array(entry.content),
            );
            console.log('😁patched', patched);
            const outputFile = `${params.unzipDirectory}/bundle.harmony.js`;
            console.log('😁outputFile', outputFile);
            const writer = await fileIo.open(outputFile, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY);
            const chunkSize = 4096;
            let bytesWritten = 0;
            const totalLength = patched.byteLength;
            while (bytesWritten < totalLength) {
              const chunk = patched.slice(bytesWritten, bytesWritten + chunkSize);
              await fileIo.write(writer.fd, chunk);
              bytesWritten += chunk.byteLength;
            }
            await fileIo.close(writer);
            continue;
          } finally {
            await fileIo.close(reader);
          }
        }
      }

      // await zip.decompressFile(entry.filename, params.unzipDirectory);
    }

    if (!foundDiff) {
      throw new Error('diff.json not found');
    }
    if (!foundBundlePatch) {
      throw new Error('bundle patch not found');
    }
    console.info('Patch from PPK completed');
  }

  private async copyFromResource(
    copyList: Map<string, Array<string>>,
  ): Promise<void> {
    try {
      // 获取应用资源路径
      const bundlePath = this.context.bundleCodeDir;

      // 遍历资源包中的文件
      const files = await fileIo.listFile(bundlePath);
      for (const file of files) {
        if (file === '.' || file === '..') continue;

        const targets = copyList.get(file);
        if (targets) {
          let lastTarget: string | undefined;

          for (const target of targets) {
            console.info(`Copying from resource ${file} to ${target}`);

            if (lastTarget) {
              // 如果已经复制过一次，直接从上一个目标复制
              await this.copyFile(lastTarget, target);
            } else {
              // 第一次复制，从资源文件复制
              const sourcePath = `${bundlePath}/${file}`;
              await this.copyFile(sourcePath, target);
              lastTarget = target;
            }
          }
        }
      }
    } catch (error) {
      console.error('Copy from resource failed:', error);
      throw error;
    }
  }

  private async doCleanUp(params: DownloadTaskParams): Promise<void> {
    const DAYS_TO_KEEP = 7;
    const now = Date.now();
    const maxAge = DAYS_TO_KEEP * 24 * 60 * 60 * 1000;

    try {
      const files = await fileIo.listFile(params.unzipDirectory);
      for (const file of files) {
        if (file.startsWith('.')) continue;

        const filePath = `${params.unzipDirectory}/${file}`;
        const stat = await fileIo.stat(filePath);

        if (
          now - stat.mtime > maxAge &&
          file !== params.hash &&
          file !== params.originHash
        ) {
          if (stat.isDirectory()) {
            await this.removeDirectory(filePath);
          } else {
            await fileIo.unlink(filePath);
          }
        }
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
      throw error;
    }
  }

  public async execute(params: DownloadTaskParams): Promise<void> {
    try {
      switch (params.type) {
        case DownloadTaskParams.TASK_TYPE_PATCH_FULL:
          await this.doFullPatch(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP:
          await this.doPatchFromApp(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
          await this.doPatchFromPpk(params);
          break;
        case DownloadTaskParams.TASK_TYPE_CLEANUP:
          await this.doCleanUp(params);
          break;
        case DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD:
          await this.downloadFile(params);
          break;
        default:
          throw new Error(`Unknown task type: ${params.type}`);
      }

      params.listener?.onDownloadCompleted(params);
    } catch (error) {
      console.error('Task execution failed:', error);
      if (params.type !== DownloadTaskParams.TASK_TYPE_CLEANUP) {
        try {
          if (params.type === DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD) {
            await fileIo.unlink(params.targetFile);
          } else {
            await this.removeDirectory(params.unzipDirectory);
          }
        } catch (cleanupError) {
          console.error('Cleanup after error failed:', cleanupError);
        }
      }
      params.listener?.onDownloadFailed(error);
    }
  }
}
