/**
 * Created by tdzl2003 on 2/13/16.
 */

import {question} from './utils';
import * as fs from 'fs-promise';

const {
  post,
  get,
  doDelete,
} = require('./api');

const validPlatforms = {
  ios: 1,
  android: 1,
};

export function checkPlatform(platform) {
  if (!validPlatforms[platform]) {
    throw new Error(`Invalid platform '${platform}'`);
  }
  return platform
}

export async function getSelectedApp(platform) {
  checkPlatform(platform);

  if (!await fs.exists('update.json')){
    throw new Error(`App not selected. run 'pushy selectApp --platform ${platform}' first!`);
  }
  const updateInfo = JSON.parse(await fs.readFile('update.json', 'utf8'));
  if (!updateInfo[platform]) {
    throw new Error(`App not selected. run 'pushy selectApp --platform ${platform}' first!`);
  }
  return updateInfo[platform];
}

export async function listApp(platform){
  const {data} = await get('/app/list');
  const list = platform?data.filter(v=>v.platform===platform):data;
  for (const app of list) {
    console.log(`${app.id}) ${app.name}(${app.platform})`);
  }
  if (platform) {
    console.log(`\nTotal ${list.length} ${platform} apps`);
  } else {
    console.log(`\nTotal ${list.length} apps`);
  }
  return list;
}

export async function chooseApp(platform) {
  const list = await listApp(platform);

  while (true) {
    const id = await question('Enter appId:');
    const app = list.find(v=>v.id === (id|0));
    if (app) {
      return app;
    }
  }
}

export const commands = {
  createApp: async function ({options}) {
    const name = options.name || await question('App Name:');
    const {downloadUrl} = options;
    const platform = checkPlatform(options.platform || await question('Platform(ios/android):'));
    const {id} = await post('/app/create', {name, platform});
    console.log(`Created app ${id}`);
    await this.selectApp({
      args: [id],
      options: {platform, downloadUrl},
    });
  },
  deleteApp: async function ({args, options}) {
    const {platform} = options;
    const id = args[0] || chooseApp(platform);
    if (!id) {
      console.log('Canceled');
    }
    await doDelete(`/app/${id}`);
    console.log('Ok.');
  },
  apps: async function ({options}){
    const {platform} = options;
    listApp(platform);
  },
  selectApp: async function({args, options}) {
    const platform = checkPlatform(options.platform || await question('Platform(ios/android):'));
    const id = args[0] || (await chooseApp(platform)).id;

    let updateInfo = {};
    if (await fs.exists('update.json')) {
      try {
        updateInfo = JSON.parse(await fs.readFile('update.json', 'utf8'));
      } catch (e) {
        console.error('Failed to parse file `update.json`. Try to remove it manually.');
        throw e;
      }
    }
    const {appKey} = await get(`/app/${id}`);
    updateInfo[platform] = {
      appId: id,
      appKey,
    };
    await fs.writeFile('update.json', JSON.stringify(updateInfo, null, 4), 'utf8');
  },
}
