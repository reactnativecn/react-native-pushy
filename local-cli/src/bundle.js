/**
 * Created by tdzl2003 on 2/22/16.
 */

import * as path from 'path';
import { mkdir } from 'mkdir-recursive';
import { getRNVersion } from './utils';


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

    const { version, major, minor} = getRNVersion();

    console.log('Bundling with React Native version: ', version);

    await new Promise((resolve, reject) => {
      mkdir(intermediaDir, err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    require(path.resolve('node_modules/react-native/packager/babelRegisterOnly'))([
      /private-cli\/src/,
      /local-cli/,
    ]);
    const Config = require(path.resolve('node_modules/react-native/local-cli/util/Config'));
    const bundle = require(path.resolve('node_modules/react-native/local-cli/bundle/bundle'));
    const defaultConfig = require(path.resolve('node_modules/react-native/local-cli/default.config'));

    bundle([
      '--entry-file',
      entryFile,
      '--platform',
      platform,
      '--dev',
      '' + !!dev,
      '--bundle-output',
      `${intermediaDir}/index.bundlejs`,
      '--assets-dest',
      `${intermediaDir}/assets`,
      '--verbose',
      '' + !!verbose,
    ], Config.get(path.resolve('node_modules/react-native/local-cli'), defaultConfig));
  }
};
