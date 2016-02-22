/**
 * Created by tdzl2003 on 2/13/16.
 */

import * as path from 'path';
import * as fs from 'fs';

var read = require('read');

export function question(query, password) {
  return new Promise((resolve, reject)=>read({
    prompt: query,
    silent: password,
    replace: password ? '*' : undefined,
  }, (err, result)=> err ? reject(err) : resolve(result)));
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