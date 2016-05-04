/**
 * Created by tdzl2003 on 4/4/16.
 */

const HotUpdate = require('react-native').NativeModules.HotUpdate;
import {NativeAppEventEmitter} from 'react-native';

let host = 'http://update.reactnative.cn/api';

export const downloadRootDir = HotUpdate.downloadRootDir;
export const packageVersion = HotUpdate.packageVersion;
export const currentVersion = HotUpdate.currentVersion;
export const isFirstTime = HotUpdate.isFirstTime;
export const isRolledBack = HotUpdate.isRolledBack;

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
export async function checkUpdate(APPKEY) {
  const resp = await fetch(`${host}/checkUpdate/${APPKEY}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      packageVersion: packageVersion,
      hash: currentVersion,
    }),
  });

  if (resp.status !== 200) {
    throw new Error((await resp.json()).message);
  }

  return await resp.json();
}

export async function downloadUpdate(options) {
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

export async function switchVersion(hash) {
  HotUpdate.reloadUpdate({hashName:hash});
}

export async function switchVersionLater(hash) {
  HotUpdate.setNeedUpdate({hashName:hash});
}

export function markSuccess() {
  HotUpdate.markSuccess();
}


NativeAppEventEmitter.addListener('RCTHotUpdateDownloadProgress',(params)=>{

})

NativeAppEventEmitter.addListener('RCTHotUpdateUnzipProgress',(params)=>{

})