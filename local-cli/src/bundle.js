/**
 * Created by tdzl2003 on 2/22/16.
 */

import * as path from 'path';
import { mkdir as mkdirRecurisve } from 'mkdir-recursive';
import { getRNVersion } from './utils';
import * as fs from 'fs';
import {ZipFile} from 'yazl';


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
        var zipfile = new ZipFile();

        function addDirectory(root, rel){
          if (rel) {
            zipfile.addEmptyDirectory(rel);
          }
          const childs = fs.readdirSync(root);
          for (const name of childs) {
            if (name === '.' || name === '..'){
              continue;
            }
            const fullPath = path.join(root, name);
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              console.log('adding: ' + rel+name);
              zipfile.addFile(fullPath, rel+name);
            } else if (stat.isDirectory()) {
              console.log('adding: ' + rel+name+'/');
              addDirectory(fullPath, rel+name+'/');
            }
          }
        }

        addDirectory(dir, '');

        zipfile.outputStream.on('error', err => reject(err));
        zipfile.outputStream.pipe(fs.createWriteStream(output))
          .on("close", function() {
            resolve();
          });
        zipfile.end();
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
