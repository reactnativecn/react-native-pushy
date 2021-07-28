import {
  tryBackupEndpoints,
  getCheckUrl,
  setCustomEndpoints,
} from './endpoint';
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  PermissionsAndroid,
} from 'react-native';
export { setCustomEndpoints };
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;

let Pushy = NativeModules.Pushy;

if (!Pushy) {
  throw new Error('react-native-update模块无法加载，请对照安装文档检查配置。');
}

export const downloadRootDir = Pushy.downloadRootDir;
export const packageVersion = Pushy.packageVersion;
export const currentVersion = Pushy.currentVersion;
export const isFirstTime = Pushy.isFirstTime;
export const isRolledBack = Pushy.isRolledBack;
export const buildTime = Pushy.buildTime;
let blockUpdate = Pushy.blockUpdate;
let uuid = Pushy.uuid;

if (Platform.OS === 'android' && !Pushy.isUsingBundleUrl) {
  throw new Error(
    'react-native-update模块无法加载，请对照文档检查Bundle URL的配置',
  );
}

const eventEmitter = new NativeEventEmitter(Pushy);

if (!uuid) {
  uuid = require('uuid/v4')();
  Pushy.setUuid(uuid);
}

function logger(text) {
  console.log(`Pushy: ${text}`);
}

logger('uuid: ' + uuid);

/*
Return json:
Package expired:
{
  expired: true,
  downloadUrl: 'http://appstore/downloadUrl',
}
Package is up to date:
{
  upToDate: true,
}
There is available update:
{
  update: true,
  name: '1.0.3-rc',
  hash: 'hash',
  description: '添加聊天功能\n修复商城页面BUG',
  metaInfo: '{"silent":true}',
  pdiffUrl: 'http://update-packages.reactnative.cn/hash',
  diffUrl: 'http://update-packages.reactnative.cn/hash',
}
 */

export const cInfo = {
  pushy: require('../package.json').version,
  rn: RNVersion,
  os: Platform.OS + ' ' + Platform.Version,
  uuid,
};

function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update can only run on RELEASE version.');
  }
}

let checkingThrottling = false;
export async function checkUpdate(APPKEY, isRetry) {
  assertRelease();
  if (checkingThrottling) {
    logger('repeated checking, ignored');
    return;
  }
  checkingThrottling = true;
  setTimeout(() => {
    checkingThrottling = false;
  }, 3000);
  if (blockUpdate && blockUpdate.until > Date.now() / 1000) {
    throw new Error(
      `热更新已暂停，原因：${blockUpdate.reason}。请在"${new Date(
        blockUpdate.until * 1000,
      ).toLocaleString()}"之后重试。`,
    );
  }
  if (typeof APPKEY !== 'string') {
    throw new Error('未检查到合法的APPKEY，请查看update.json文件是否正确生成');
  }
  logger('checking update');
  let resp;
  try {
    resp = await fetch(getCheckUrl(APPKEY), {
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
    });
  } catch (e) {
    if (isRetry) {
      throw new Error('Could not connect to pushy server');
    }
    await tryBackupEndpoints(APPKEY);
    return checkUpdate(APPKEY, true);
  }
  const result = await resp.json();
  checkOperation(result.op);

  if (resp.status !== 200) {
    throw new Error(result.message);
  }

  return result;
}

function checkOperation(op) {
  if (!Array.isArray(op)) {
    return;
  }
  op.forEach((action) => {
    if (action.type === 'block') {
      blockUpdate = {
        reason: action.reason,
        until: Math.round((Date.now() + action.duration) / 1000),
      };
      Pushy.setBlockUpdate(blockUpdate);
    }
  });
}

let downloadingThrottling = false;
let downloadedHash;
export async function downloadUpdate(options, eventListeners) {
  assertRelease();
  if (!options.update) {
    return;
  }
  if (downloadedHash === options.hash) {
    logger(`duplicated downloaded hash ${downloadedHash}, ignored`);
    return;
  }
  if (downloadingThrottling) {
    logger('repeated downloading, ignored');
    return;
  }
  downloadingThrottling = true;
  setTimeout(() => {
    downloadingThrottling = false;
  }, 3000);
  let progressHandler;
  if (eventListeners) {
    if (eventListeners.onDownloadProgress) {
      const downloadCallback = eventListeners.onDownloadProgress;
      progressHandler = eventEmitter.addListener(
        'RCTPushyDownloadProgress',
        (progressData) => {
          if (progressData.hash === options.hash) {
            downloadCallback(progressData);
          }
        },
      );
    }
  }
  if (options.diffUrl) {
    logger('downloading diff');
    try {
      await Pushy.downloadPatchFromPpk({
        updateUrl: options.diffUrl,
        hash: options.hash,
        originHash: currentVersion,
      });
    } catch (e) {
      logger(e.message);
      logger('diff error, try pdiff');
      await Pushy.downloadPatchFromPackage({
        updateUrl: options.pdiffUrl,
        hash: options.hash,
      });
    }
  } else if (options.pdiffUrl) {
    logger('downloading pdiff');
    await Pushy.downloadPatchFromPackage({
      updateUrl: options.pdiffUrl,
      hash: options.hash,
    });
  }
  progressHandler && progressHandler.remove();
  downloadedHash = options.hash;
  return options.hash;
}

export function switchVersion(hash) {
  assertRelease();
  logger('switchVersion');
  Pushy.reloadUpdate({ hash });
}

let readyHash;
export function switchVersionLater(hash) {
  assertRelease();
  if (readyHash === hash) {
    logger(`duplicated ready hash ${readyHash}, ignored`);
    return;
  }
  readyHash = hash;
  logger('switchVersionLater');
  Pushy.setNeedUpdate({ hash });
}

let marked = false;
export function markSuccess() {
  assertRelease();
  if (marked) {
    logger('repeated markSuccess, ignored');
    return;
  }
  marked = true;
  logger('markSuccess');
  Pushy.markSuccess();
}

export async function downloadAndInstallApk({ url, onDownloadProgress }) {
  logger('downloadAndInstallApk');
  if (Platform.OS === 'android' && Platform.Version <= 23) {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        return;
      }
    } catch (err) {
      console.warn(err);
    }
  }
  let hash = Date.now().toString();
  let progressHandler;
  if (onDownloadProgress) {
    progressHandler = eventEmitter.addListener(
      'RCTPushyDownloadProgress',
      (progressData) => {
        if (progressData.hash === hash) {
          onDownloadProgress(progressData);
        }
      },
    );
  }
  await Pushy.downloadAndInstallApk({
    url,
    target: 'update.apk',
    hash,
  });
  progressHandler && progressHandler.remove();
}
