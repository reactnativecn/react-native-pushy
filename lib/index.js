import { NativeAppEventEmitter, NativeModules } from 'react-native';
const HotUpdate = NativeModules.HotUpdate || {};

const host = 'https://update.reactnative.cn/api';

export const downloadRootDir = HotUpdate.downloadRootDir;
export const packageVersion = HotUpdate.packageVersion;
export const currentVersion = HotUpdate.currentVersion;
export const isFirstTime = HotUpdate.isFirstTime;
export const isRolledBack = HotUpdate.isRolledBack;
export const buildTime = HotUpdate.buildTime;

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
    await HotUpdate.downloadPatchFromPpk({
      updateUrl: options.diffUrl,
      hashName: options.hash,
      originHashName: currentVersion,
    });
  } else if (options.pdiffUrl) {
    await HotUpdate.downloadPatchFromPackage({
      updateUrl: options.pdiffUrl,
      hashName: options.hash,
    });
  } else {
    await HotUpdate.downloadUpdate({
      updateUrl: options.updateUrl,
      hashName: options.hash,
    });
  }
  return options.hash;
}

export function switchVersion(hash) {
  assertRelease();
  HotUpdate.reloadUpdate({ hashName: hash });
}

export function switchVersionLater(hash) {
  assertRelease();
  HotUpdate.setNeedUpdate({ hashName: hash });
}

export function markSuccess() {
  assertRelease();
  HotUpdate.markSuccess();
}

NativeAppEventEmitter.addListener('RCTHotUpdateDownloadProgress', params => {});

NativeAppEventEmitter.addListener('RCTHotUpdateUnzipProgress', params => {});
