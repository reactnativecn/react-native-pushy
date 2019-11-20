/**
 * Created by tdzl2003 on 2/13/16.
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import ipaReader from './ipaReader';
const AppInfoParser = require('app-info-parser');

var read = require('read');

export function question(query, password) {
  if (NO_INTERACTIVE) {
    return Promise.resolve('');
  }
  return new Promise((resolve, reject) =>
    read(
      {
        prompt: query,
        silent: password,
        replace: password ? '*' : undefined,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    ),
  );
}

export function translateOptions(options) {
  const ret = {};
  for (let key in options) {
    const v = options[key];
    if (typeof v === 'string') {
      ret[key] = v.replace(/\$\{(\w+)\}/g, function(v, n) {
        return options[n] || process.env[n] || v;
      });
    } else {
      ret[key] = v;
    }
  }
  return ret;
}

export function getRNVersion() {
  const version = JSON.parse(fs.readFileSync(path.resolve('node_modules/react-native/package.json'))).version;

  // We only care about major and minor version.
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return {
    version,
    major: match[1] | 0,
    minor: match[2] | 0,
  };
}

export async function getAppInfo(fn) {
  const parser = new AppInfoParser(fn);
  const { versionName, application } = await parser.parse();
  let buildTime = 0;
  if (Array.isArray(application.metaData)) {
    for (const meta of application.metaData) {
      if (meta.name === 'pushy_build_time') {
        buildTime = meta.value[0];
      }
    }
  }
  if (buildTime == 0) {
    throw new Error('Can not get build time for this app.')
  }
  return { versionName, buildTime };
}

export function getIPAVersion(fn) {
  return new Promise((resolve, reject) => {
    ipaReader(fn, (err, data) => {
      err ? reject(err) : resolve(data.metadata.CFBundleShortVersionString);
    });
  });
}
