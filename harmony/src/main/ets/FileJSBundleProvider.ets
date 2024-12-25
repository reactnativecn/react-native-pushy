import { HotReloadConfig, JSBundleProvider, JSBundleProviderError, JSPackagerClientConfig } from 'rnoh';
import fileIo from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import { UpdateContext } from './UpdateContext';

export class FileJSBundleProvider extends JSBundleProvider {
  private updateContext: UpdateContext;
  private filePath: string = ''

  constructor(context: common.UIAbilityContext) {
    super();
    this.updateContext = new UpdateContext(context);
  }
  getURL(): string {
    return this.updateContext.getBundleUrl();
  }

  async getBundle(): Promise<ArrayBuffer> {
    try {
      this.filePath =  this.updateContext.getBundleUrl();
      const res = fileIo.accessSync(this.filePath);
      if (res) {
        const file = fileIo.openSync(this.filePath, fileIo.OpenMode.READ_ONLY);
        try {
          const stat = await fileIo.stat(this.filePath);
          const fileSize = stat.size;
          const buffer = new ArrayBuffer(fileSize);
          const bytesRead = fileIo.readSync(file.fd, buffer, {
            offset: 0,
            length: fileSize
          });
          
          if (bytesRead !== fileSize) {
            throw new Error(`Failed to read entire file: read ${bytesRead} of ${fileSize} bytes`);
          }
          return buffer;
        } finally {
          fileIo.closeSync(file.fd);
        }
      }
      throw new Error('Update bundle not found');
    } catch (error) {
      throw new JSBundleProviderError(`Couldn't load JSBundle from ${this.filePath}`, error)
    }
  }

  getAppKeys(): string[] {
    return [];
  }

  getHotReloadConfig(): HotReloadConfig | null {
   return null;
  }

  getJSPackagerClientConfig(): JSPackagerClientConfig | null {
    return null;
  }

}