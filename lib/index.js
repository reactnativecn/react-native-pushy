import { NativeAppEventEmitter, NativeModules } from 'react-native';
const Pushy = NativeModules.Pushy || {};

const host = 'https://update.reactnative.cn/api';

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
  updateUrl: 'http://update-packages.reactnative.cn/hash',
  pdiffUrl: 'http://update-packages.reactnative.cn/hash',
  diffUrl: 'http://update-packages.reactnative.cn/hash',
}
 */

function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update can only run on RELEASE version.');
  }
}

export async function checkUpdate(APPKEY) {
  assertRelease();
  const resp = await fetch(`${host}/checkUpdate/${APPKEY}`, {
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

NativeAppEventEmitter.addListener('RCTPushyDownloadProgress', params => {});

NativeAppEventEmitter.addListener('RCTPushyUnzipProgress', params => {});
