/**
 * Created by tdzl2003 on 2/22/16.
 */

import * as path from 'path';
import { mkdir as mkdirRecurisve } from 'mkdir-recursive';
import { getRNVersion } from './utils';
import * as fs from 'fs';
import * as tar from 'tar';
import fstream from 'fstream';

function mkdir(dir){
  return new Promise((resolve, reject) => {
    mkdirRecurisve(dir, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function pack(dir, output){
  return mkdir(path.dirname(output))
    .then(()=>{
      return new Promise((resolve, reject) => {
        const dest = fs.createWriteStream(output);

        var packer = tar.Pack({
            noProprietary: true,
            fromBase: true,
          })
          .on('error', err => {
            reject(err);
          })
          .on('end', () => {
            resolve();
          });

        fstream.Reader({ path: dir, type: "Directory" })
          .on('error', err => {
            reject(err);
          })
          .pipe(packer)
          .pipe(dest);
      });
    })
}

export const commands = {
  bundle: async function({options}){
    const {
      entryFile,
      intermediaDir,
      platform,
      output,
      dev,
      verbose
    } = options;

    if (!platform) {
      throw new Error('Platform must be specified.');
    }

    await mkdir(intermediaDir);

    const { version, major, minor} = getRNVersion();

    console.log('Bundling with React Native version: ', version);

    await mkdir(intermediaDir);

    require(path.resolve('node_modules/react-native/packager/babelRegisterOnly'))([
      /private-cli\/src/,
      /local-cli/,
    ]);
    const Config = require(path.resolve('node_modules/react-native/local-cli/util/Config'));
    const bundle = require(path.resolve('node_modules/react-native/local-cli/bundle/bundle'));
    const defaultConfig = require(path.resolve('node_modules/react-native/local-cli/default.config'));

    await bundle([
      '--entry-file',
      entryFile,
      '--platform',
      platform,
      '--dev',
      '' + !!dev,
      '--bundle-output',
      `${intermediaDir}/index.bundlejs`,
      '--assets-dest',
      `${intermediaDir}`,
      '--verbose',
      '' + !!verbose,
    ], Config.get(path.resolve('node_modules/react-native/local-cli'), defaultConfig));

    console.log('Packing');

    await pack(intermediaDir, output);
  }
};
