/**
 * Created by tdzl2003 on 4/2/16.
 */

const {
  get,
  post,
  uploadFile,
} = require('./api');
import { question } from './utils';

import { checkPlatform, getSelectedApp } from './app';

import {getIPAVersion, getApkVersion} from './utils';

export async function listPackage(appId){
  const {data} = await get(`/app/${appId}/package/list?limit=1000`);
  for (const pkg of data) {
    const {version} = pkg;
    let versionInfo = '';
    if (version) {
      versionInfo = ` - ${version.id} ${version.hash.slice(0, 8)} ${version.name}`;
    } else {
      versionInfo = ' (newest)';
    }
    console.log(`${pkg.id}) ${pkg.name}(${pkg.status})${versionInfo}`);
  }
  console.log(`\nTotal ${data.length} packages.`);
  return data;
}

export async function choosePackage(appId) {
  const list = await listPackage(appId);

  while (true) {
    const id = await question('Enter packageId:');
    const app = list.find(v=>v.id === (id|0));
    if (app) {
      return app;
    }
  }
}

export const commands = {
  uploadIpa: async function({args}) {
    const fn = args[0];
    if (!fn) {
      throw new Error('Usage: pushy uploadIpa <ipaFile>');
    }
    const name = await getIPAVersion(fn);
    const {appId} = await getSelectedApp('ios');

    const {hash} = await uploadFile(fn);

    const {id} = await post(`/app/${appId}/package/create`, {
      name,
      hash,
    });
    console.log(`Ipa uploaded: ${id}`);
  },
  uploadApk: async function({args}) {
    const fn = args[0];
    if (!fn) {
      throw new Error('Usage: pushy uploadApk <apkFile>');
    }
    const name = await getApkVersion(fn);
    const {appId} = await getSelectedApp('android');

    const {hash} = await uploadFile(fn);

    const {id} = await post(`/app/${appId}/package/create`, {
      name,
      hash,
    });
    console.log(`Apk uploaded: ${id}`);
  },
  packages: async function({options}) {
    const platform = checkPlatform(options.platform || await question('Platform(ios/android):'));
    const { appId } = await getSelectedApp(platform);
    await listPackage(appId);
  },
};
