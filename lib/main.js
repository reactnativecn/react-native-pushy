import {
  tryBackupEndpoints,
  getCheckUrl,
  setCustomEndpoints,
  getReportUrl,
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
const rolledBackVersion = Pushy.rolledBackVersion;
export const isRolledBack = typeof rolledBackVersion === 'string';

export const buildTime = Pushy.buildTime;
let blockUpdate = Pushy.blockUpdate;
let uuid = Pushy.uuid;

if (Platform.OS === 'android' && !Pushy.isUsingBundleUrl) {
  throw new Error(
    'react-native-update模块无法加载，请对照文档检查Bundle URL的配置',
  );
}

function setLocalHashInfo(hash, info) {
  Pushy.setLocalHashInfo(hash, JSON.stringify(info));
}

async function getLocalHashInfo(hash) {
  return JSON.parse(await Pushy.getLocalHashInfo(hash));
}

export async function getCurrentVersionInfo() {
  return currentVersion ? (await getLocalHashInfo(currentVersion)) || {} : {};
}

const eventEmitter = new NativeEventEmitter(Pushy);

if (!uuid) {
  uuid = require('nanoid/non-secure').nanoid();
  Pushy.setUuid(uuid);
}

function logger(text) {
  console.log(`Pushy: ${text}`);
}

function report(hash, type) {
  logger(type);
  fetch(getReportUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      hash,
      type,
      cInfo,
      packageVersion,
      buildTime,
    }),
  }).catch((_e) => {});
}

logger('uuid: ' + uuid);

if (isRolledBack) {
  report(rolledBackVersion, 'rollback');
}

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
  if (rolledBackVersion === options.hash) {
    logger(`rolledback hash ${rolledBackVersion}, ignored`);
    return;
  }
  if (downloadedHash === options.hash) {
    logger(`duplicated downloaded hash ${downloadedHash}, ignored`);
    return;
  }
  if (readyHash) {
    logger(`hash ${readyHash} applied. reboot first`);
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
      logger(`diff error: ${e.message}, try pdiff`);
      try {
        await Pushy.downloadPatchFromPackage({
          updateUrl: options.pdiffUrl,
          hash: options.hash,
        });
      } catch (e) {
        progressHandler && progressHandler.remove();
        report(options.hash, 'error');
        return;
      }
    }
  } else if (options.pdiffUrl) {
    logger('downloading pdiff');
    try {
      await Pushy.downloadPatchFromPackage({
        updateUrl: options.pdiffUrl,
        hash: options.hash,
      });
    } catch (e) {
      progressHandler && progressHandler.remove();
      report(options.hash, 'error');
      return;
    }
  }
  setLocalHashInfo(options.hash, {
    name: options.name,
    description: options.description,
    metaInfo: options.metaInfo,
  });
  progressHandler && progressHandler.remove();
  downloadedHash = options.hash;
  return options.hash;
}

let readyHash;
function assertHash(hash) {
  if (!downloadedHash) {
    logger(`no downloaded hash`);
    return;
  }
  if (hash !== downloadedHash) {
    logger(`use downloaded hash ${downloadedHash} first`);
    return;
  }
  if (readyHash === hash) {
    logger(`hash ${readyHash} already applied. reboot first.`);
    return;
  }
  readyHash = hash;
  return true;
}

export function switchVersion(hash) {
  assertRelease();
  if (assertHash(hash)) {
    logger('switchVersion: ' + hash);
    Pushy.reloadUpdate({ hash });
  }
}

export function switchVersionLater(hash) {
  assertRelease();
  if (assertHash(hash)) {
    logger('switchVersionLater: ' + hash);
    Pushy.setNeedUpdate({ hash });
  }
}

let marked = false;
export function markSuccess() {
  assertRelease();
  if (marked) {
    logger('repeated markSuccess, ignored');
    return;
  }
  marked = true;
  Pushy.markSuccess();
  report(currentVersion, 'success');
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
