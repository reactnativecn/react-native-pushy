/**
 * @format
 * @flow strict-local
 */
'use strict';

import type { TurboModule } from 'react-native/Libraries/TurboModule/RCTExport';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getConstants: () => {
    downloadRootDir: string,
    packageVersion: string,
    currentVersion: string,
    isFirstTime: boolean,
    rolledBackVersion: string,
    buildTime: string,
    blockUpdate: Object,
    uuid: string,
    isUsingBundleUrl: boolean,
  };
  setLocalHashInfo(hash: string, info: string): void;
  getLocalHashInfo(hash: string): Promise<string>;
  setUuid(uuid: string): void;
  setBlockUpdate(options: { reason: string, until: number }): void;
  downloadPatchFromPpk(options: {
    updateUrl: string,
    hash: string,
    originHash: string,
  }): Promise<void>;
  downloadPatchFromPackage(options: {
    updateUrl: string,
    hash: string,
  }): Promise<void>;
  downloadFullUpdate(options: {
    updateUrl: string,
    hash: string,
  }): Promise<void>;
  reloadUpdate(options: { hash: string }): void;
  setNeedUpdate(options: { hash: string }): void;
  markSuccess(): void;
  downloadAndInstallApk(options: {
    url: string,
    target: string,
    hash: string,
  }): Promise<void>;
}

export default (TurboModuleRegistry.get<Spec>('Pushy'): ?Spec);
