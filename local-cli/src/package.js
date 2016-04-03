/**
 * Created by tdzl2003 on 4/2/16.
 */

const {
  get,
  post,
  uploadFile,
} = require('./api');

import { checkPlatform, getSelectedApp } from './app';

import {getIPAVersion, getApkVersion} from './utils';

export const commands = {
  uploadIpa: async function({args}) {
    const fn = args[0];
    if (!fn) {
      throw new Error('Usage: pushy uploadIpa <ipaFile>');
    }
    const name = await getIPAVersion(fn);
    const {appId} = await getSelectedApp('ios');

    const {hash} = await uploadFile(fn);

    await post(`/app/${appId}/package/create`, {
      name,
      hash,
    });
    console.log('Ok.');
  },
  uploadApk: async function({args}) {
    const fn = args[0];
    if (!fn) {
      throw new Error('Usage: pushy uploadApk <ipaFile>');
    }
    const name = await getApkVersion(fn);
    const {appId} = await getSelectedApp('android');

    const {hash} = await uploadFile(fn);

    await post(`/app/${appId}/package/create`, {
      name,
      hash,
    });
    console.log('Ok.');
  },
};
