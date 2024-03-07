import { CheckResult, PushyOptions, ProgressData, EventType } from './type';
import { assertRelease, log, testUrls } from './utils';
import {
  EmitterSubscription,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {
  PushyModule,
  buildTime,
  cInfo,
  pushyNativeEventEmitter,
  currentVersion,
  packageVersion,
  rolledBackVersion,
  setLocalHashInfo,
  isRolledBack,
} from './core';

const defaultServer = {
  main: 'https://update.react-native.cn/api',
  backups: ['https://update.reactnative.cn/api'],
  queryUrl:
    'https://raw.githubusercontent.com/reactnativecn/react-native-pushy/master/endpoints.json',
};

const empty = {};
const noop = () => {};

export class Pushy {
  options: PushyOptions = {
    appKey: '',
    server: defaultServer,
    autoMarkSuccess: true,
    useAlert: true,
    strategy: 'both',
    logger: noop,
  };

  lastChecking?: number;
  lastRespJson?: Promise<any>;

  progressHandlers: Record<string, EmitterSubscription> = {};
  downloadedHash?: string;

  marked = false;
  applyingUpdate = false;
  version = cInfo.pushy;

  constructor(options: PushyOptions) {
    if (!options.appKey) {
      throw new Error('appKey is required');
    }
    this.setOptions(options);
  }

  setOptions = (options: Partial<PushyOptions>) => {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        // @ts-expect-error
        this.options[key] = value;
        if (key === 'logger') {
          if (isRolledBack) {
            this.report({
              type: 'rollback',
              data: {
                rolledBackVersion,
              },
            });
          }
        }
      }
    }
  };

  report = ({
    type,
    message = '',
    data = {},
  }: {
    type: EventType;
    message?: string;
    data?: Record<string, string | number>;
  }) => {
    log(type + ' ' + message);
    const { logger = noop, appKey } = this.options;
    logger({
      type,
      data: {
        appKey,
        currentVersion,
        cInfo,
        packageVersion,
        buildTime,
        message,
        ...data,
      },
    });
  };

  getCheckUrl = (endpoint: string = this.options.server!.main) => {
    return `${endpoint}/checkUpdate/${this.options.appKey}`;
  };
  assertHash = (hash: string) => {
    if (!this.downloadedHash) {
      return;
    }
    if (hash !== this.downloadedHash) {
      log(`use downloaded hash ${this.downloadedHash} first`);
      return;
    }
    return true;
  };
  markSuccess = () => {
    assertRelease();
    if (this.marked) {
      return;
    }
    this.marked = true;
    PushyModule.markSuccess();
    this.report({ type: 'markSuccess' });
  };
  switchVersion = (hash: string) => {
    assertRelease();
    if (this.assertHash(hash) && !this.applyingUpdate) {
      log('switchVersion: ' + hash);
      this.applyingUpdate = true;
      PushyModule.reloadUpdate({ hash });
    }
  };

  switchVersionLater = (hash: string) => {
    assertRelease();
    if (this.assertHash(hash)) {
      log('switchVersionLater: ' + hash);
      PushyModule.setNeedUpdate({ hash });
    }
  };
  checkUpdate = async () => {
    assertRelease();
    const now = Date.now();
    if (
      this.lastRespJson &&
      this.lastChecking &&
      now - this.lastChecking < 1000 * 5
    ) {
      return await this.lastRespJson;
    }
    this.lastChecking = now;
    this.report({ type: 'checking' });
    const fetchPayload = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packageVersion,
        hash: currentVersion,
        buildTime,
        cInfo,
      }),
    };
    let resp;
    try {
      resp = await fetch(this.getCheckUrl(), fetchPayload);
    } catch (e: any) {
      this.report({
        type: 'errorChecking',
        message: 'Can not connect to update server. Trying backup endpoints.',
      });
      const backupEndpoints = await this.getBackupEndpoints();
      if (backupEndpoints) {
        try {
          resp = await Promise.race(
            backupEndpoints.map(endpoint =>
              fetch(this.getCheckUrl(endpoint), fetchPayload),
            ),
          );
        } catch {}
      }
    }
    if (!resp) {
      this.report({
        type: 'errorChecking',
        message: 'Can not connect to update server. Please check your network.',
      });
      return this.lastRespJson ? await this.lastRespJson : empty;
    }
    this.lastRespJson = resp.json();

    const result: CheckResult = await this.lastRespJson;

    if (resp.status !== 200) {
      this.report({
        type: 'errorChecking',
        message: result.message,
      });
    }

    return result;
  };
  getBackupEndpoints = async () => {
    const { server } = this.options;
    if (!server) {
      return [];
    }
    if (server.queryUrl) {
      try {
        const resp = await fetch(server.queryUrl);
        const remoteEndpoints = await resp.json();
        log('fetch endpoints:', remoteEndpoints);
        if (Array.isArray(remoteEndpoints)) {
          server.backups = Array.from(
            new Set([...(server.backups || []), ...remoteEndpoints]),
          );
        }
      } catch (e: any) {
        log('failed to fetch endpoints from: ', server.queryUrl);
      }
    }
    return server.backups;
  };
  downloadUpdate = async (
    info: CheckResult,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    assertRelease();
    const {
      hash,
      diffUrl: _diffUrl,
      diffUrls,
      pdiffUrl: _pdiffUrl,
      pdiffUrls,
      updateUrl: _updateUrl,
      updateUrls,
      name,
      description,
      metaInfo,
    } = info;
    if (!info.update || !hash) {
      return;
    }
    if (rolledBackVersion === hash) {
      log(`rolledback hash ${rolledBackVersion}, ignored`);
      return;
    }
    if (this.downloadedHash === hash) {
      log(`duplicated downloaded hash ${this.downloadedHash}, ignored`);
      return this.downloadedHash;
    }
    if (this.progressHandlers[hash]) {
      return;
    }
    if (onDownloadProgress) {
      this.progressHandlers[hash] = pushyNativeEventEmitter.addListener(
        'RCTPushyDownloadProgress',
        progressData => {
          if (progressData.hash === hash) {
            onDownloadProgress(progressData);
          }
        },
      );
    }
    let succeeded = false;
    this.report({ type: 'downloading' });
    const diffUrl = (await testUrls(diffUrls)) || _diffUrl;
    if (diffUrl) {
      log('downloading diff');
      try {
        await PushyModule.downloadPatchFromPpk({
          updateUrl: diffUrl,
          hash,
          originHash: currentVersion,
        });
        succeeded = true;
      } catch (e: any) {
        log(`diff error: ${e.message}, try pdiff`);
      }
    }
    const pdiffUrl = (await testUrls(pdiffUrls)) || _pdiffUrl;
    if (!succeeded && pdiffUrl) {
      log('downloading pdiff');
      try {
        await PushyModule.downloadPatchFromPackage({
          updateUrl: pdiffUrl,
          hash,
        });
        succeeded = true;
      } catch (e: any) {
        log(`pdiff error: ${e.message}, try full patch`);
      }
    }
    const updateUrl = (await testUrls(updateUrls)) || _updateUrl;
    if (!succeeded && updateUrl) {
      log('downloading full patch');
      try {
        await PushyModule.downloadFullUpdate({
          updateUrl: updateUrl,
          hash,
        });
        succeeded = true;
      } catch (e: any) {
        log(`full patch error: ${e.message}`);
      }
    }
    if (this.progressHandlers[hash]) {
      this.progressHandlers[hash].remove();
      delete this.progressHandlers[hash];
    }
    if (!succeeded) {
      return this.report({
        type: 'errorUpdate',
        data: { newVersion: hash },
      });
    }
    log('downloaded hash:', hash);
    setLocalHashInfo(hash, {
      name,
      description,
      metaInfo,
    });
    this.downloadedHash = hash;
    return hash;
  };
  downloadAndInstallApk = async (
    url: string,
    onDownloadProgress?: (data: ProgressData) => void,
  ) => {
    if (Platform.OS !== 'android') {
      return;
    }
    this.report({ type: 'downloadingApk' });
    if (Platform.Version <= 23) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          return this.report({ type: 'rejectStoragePermission' });
        }
      } catch (e: any) {
        return this.report({ type: 'errorStoragePermission' });
      }
    }
    const progressKey = 'downloadingApk';
    if (onDownloadProgress) {
      this.progressHandlers[progressKey] = pushyNativeEventEmitter.addListener(
        'RCTPushyDownloadProgress',
        (progressData: ProgressData) => {
          if (progressData.hash === progressKey) {
            onDownloadProgress(progressData);
          }
        },
      );
    }
    await PushyModule.downloadAndInstallApk({
      url,
      target: 'update.apk',
      hash: progressKey,
    }).catch(() => {
      this.report({ type: 'errowDownloadAndInstallApk' });
    });
    if (this.progressHandlers[progressKey]) {
      this.progressHandlers[progressKey].remove();
      delete this.progressHandlers[progressKey];
    }
  };
}
