import {
  tryBackupEndpoints,
  getCheckUrl,
  setCustomEndpoints,
} from './endpoint';
import { NativeAppEventEmitter, NativeModules, Platform } from 'react-native';
export { setCustomEndpoints };
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;
const uuidv4 = require('uuid/v4');

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

if (!uuid) {
  uuid = uuidv4();
  Pushy.setUuid(uuid);
}

console.log('Pushy uuid: ' + uuid);

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

function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update can only run on RELEASE version.');
  }
}

export async function checkUpdate(APPKEY, isRetry) {
  assertRelease();
  if (blockUpdate && blockUpdate.until > Date.now() / 1000) {
    throw new Error(
      `热更新已暂停，原因：${blockUpdate.reason}。请在"${new Date(
        blockUpdate.until * 1000,
      ).toLocaleString()}"之后重试。`,
    );
  }
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
        cInfo: {
          pushy: require('../package.json').version,
          rn: RNVersion,
          os: Platform.OS + ' ' + Platform.Version,
          uuid,
        },
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
        until: (Date.now() + action.duration) / 1000,
      };
      Pushy.setBlockUpdate(blockUpdate);
    }
  });
}

export async function downloadUpdate(options) {
  assertRelease();
  if (!options.update) {
    return;
  }
  if (options.diffUrl) {
    await Pushy.downloadPatchFromPpk({
      updateUrl: options.diffUrl,
      hashName: options.hash,
      originHashName: currentVersion,
    });
  } else if (options.pdiffUrl) {
    await Pushy.downloadPatchFromPackage({
      updateUrl: options.pdiffUrl,
      hashName: options.hash,
    });
  }
  return options.hash;
}

export function switchVersion(hash) {
  assertRelease();
  Pushy.reloadUpdate({ hashName: hash });
}

export function switchVersionLater(hash) {
  assertRelease();
  Pushy.setNeedUpdate({ hashName: hash });
}

export function markSuccess() {
  assertRelease();
  Pushy.markSuccess();
}

NativeAppEventEmitter.addListener('RCTPushyDownloadProgress', (params) => {});

NativeAppEventEmitter.addListener('RCTPushyUnzipProgress', (params) => {});
