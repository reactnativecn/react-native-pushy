import getHost, { tryBackupDomains } from './getHost';
import { NativeAppEventEmitter, NativeModules } from 'react-native';

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

/*
Return json:
Package was expired:
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
  let resp;
  try {
    resp = await fetch(`${getHost()}/checkUpdate/${APPKEY}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packageVersion,
        hash: currentVersion,
        buildTime,
      }),
    });
  } catch (e) {
    if (isRetry) {
      throw new Error('Could not connect to pushy server');
    }
    await tryBackupDomains();
    return checkUpdate(APPKEY, true);
  }

  if (resp.status !== 200) {
    throw new Error((await resp.json()).message);
  }

  return resp.json();
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
  } else {
    await Pushy.downloadUpdate({
      updateUrl: options.updateUrl,
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

// function report(action) {
//   // ${project}.${host}/logstores/${logstore}/track?APIVersion=0.6.0&key1=val1
//   fetch(`${logUrl}&action=${action}`);
// }

NativeAppEventEmitter.addListener('RCTPushyDownloadProgress', params => {});

NativeAppEventEmitter.addListener('RCTPushyUnzipProgress', params => {});
