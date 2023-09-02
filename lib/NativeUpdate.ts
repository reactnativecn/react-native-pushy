import type { TurboModule } from 'react-native/Libraries/TurboModule/RCTExport';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getConstants: () => {
    downloadRootDir: string;
    packageVersion: string;
    currentVersion: string;
    isFirstTime: boolean;
    rolledBackVersion: string;
    buildTime: string;
    blockUpdate: Object;
    uuid: string;
    isUsingBundleUrl: boolean;
  };
  setLocalHashInfo(hash: string, info: string): Promise<void>;
  getLocalHashInfo(hash: string): Promise<string>;
  setUuid(uuid: string): Promise<void>;
  setBlockUpdate(options: { reason: string; until: number }): Promise<void>;
  reloadUpdate(options: { hash: string }): Promise<void>;
  setNeedUpdate(options: { hash: string }): Promise<void>;
  markSuccess(): Promise<void>;
  downloadPatchFromPpk(options: {
    updateUrl: string;
    hash: string;
    originHash: string;
  }): Promise<void>;
  downloadPatchFromPackage(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void>;
  downloadFullUpdate(options: {
    updateUrl: string;
    hash: string;
  }): Promise<void>;
  downloadAndInstallApk(options: {
    url: string;
    target: string;
    hash: string;
  }): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('Pushy') as Spec | null;
