/**
 * Created by tdzl2003 on 4/2/16.
 */

const {
  get,
  post,
  put,
  uploadFile,
} = require('./api');
import { question } from './utils';

import { checkPlatform, getSelectedApp } from './app';
import { choosePackage } from './package';

async function showVersion(appId, offset) {
  const { data, count } = await get(`/app/${appId}/version/list`);
  console.log(`Offset ${offset}`);
  for (const version of data) {
    let packageInfo = version.packages.slice(0, 3).map(v=>v.name).join(', ');
    const count = version.packages.length;
    if (count > 3) {
      packageInfo += `...and ${count-3} more`;
    }
    if (count === 0) {
      packageInfo = `(no package)`;
    } else {
      packageInfo = `[${packageInfo}]`;
    }
    console.log(`${version.id}) ${version.hash.slice(0, 8)} ${version.name} ${packageInfo}`);
  }
  return data;
}

async function listVersions(appId) {
  let offset = 0;
  while (true) {
    await showVersion(appId, offset);
    const cmd = await question('page Up/page Down/Begin/Quit(U/D/B/Q)');
    switch (cmd.toLowerCase()) {
      case 'u': offset = Math.max(0, offset - 10); break;
      case 'd': offset += 10; break;
      case 'b': offset = 0; break;
      case 'q': return;
    }
  }
}

async function chooseVersion(appId) {
  let offset = 0;
  while (true) {
    const data = await showVersion(appId, offset);
    const cmd = await question('Enter versionId or page Up/page Down/Begin(U/D/B)');
    switch (cmd.toLowerCase()) {
      case 'U': offset = Math.max(0, offset - 10); break;
      case 'D': offset += 10; break;
      case 'B': offset = 0; break;
      default:
      {
        console.log(data.find(v=>v.id === (cmd | 0)));
        const v = data.find(v=>v.id === (cmd | 0));
        if (v) {
          return v;
        }
      }
    }
  }
}

export const commands = {
  publish: async function({args, options}) {
    const fn = args[0];
    const {platform, name, description, metaInfo } = options;
    if (!fn || !platform) {
      throw new Error('Usage: pushy publish <ppkFile> --platform ios|android');
    }
    const { appId } = await getSelectedApp(platform);

    const { hash } = await uploadFile(fn);

    const { id } = await post(`/app/${appId}/version/create`, {
      name,
      hash,
      description,
      metaInfo,
    });
    console.log('Ok.');

    const v = await question('Would you like to bind packages to this version?(Y/N)');
    if (v.toLowerCase() === 'y') {
      await this.update({args:[], options:{packageId: id, }});
    }
  },
  versions: async function({options}) {
    const { platform } = options;
    const { appId } = await getSelectedApp(platform);
    await listVersions(appId);
  },
  update: async function({args, options}) {
    const { platform } = options;
    const { appId } = await getSelectedApp(platform);
    const version = await chooseVersion(appId);
    const pkg = await choosePackage(appId);
    await put(`/app/${appId}/package/${pkg.id}`, {
      versionId: version.id,
    });
    console.log('Ok.');
  }
};
