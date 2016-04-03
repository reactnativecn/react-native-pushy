/**
 * Created by tdzl2003 on 4/2/16.
 */

const {
  get,
  post,
  uploadFile,
} = require('./api');

import { checkPlatform, getSelectedApp } from './app';

export const commands = {
  publish: async function({args, options}) {
    const fn = args[0];
    const {platform, name, description, metaInfo } = options;
    if (!fn || !platform) {
      throw new Error('Usage: pushy publish <ppkFile> --platform ios|android');
    }
    const {appId} = await getSelectedApp(platform);

    const {hash} = await uploadFile(fn);

    const {id} = await post(`/app/${appId}/version/create`, {
      name,
      hash,
      description,
      metaInfo,
    });
    console.log('Ok.');
  },
};
