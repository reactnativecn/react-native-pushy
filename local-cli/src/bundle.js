/**
 * Created by tdzl2003 on 2/22/16.
 */

import * as path from 'path';
import { mkdir as mkdirRecurisve } from 'mkdir-recursive';
import {
  getRNVersion,
  translateOptions,
} from './utils';
import * as fs from 'fs';
import {ZipFile} from 'yazl';
import {open as openZipFile} from 'yauzl';

import crypto from 'crypto';

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

function calcMd5ForFile(fn) {
  return new Promise((resolve, reject) => {
    var hash = crypto.createHash('md5'),
      stream = fs.createReadStream(fn);

    stream.on('data', (data) => hash.update(data, 'utf8'));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  })
}

async function calcMd5ForDirectory(dir) {
  const childs = fs.readdirSync(dir).sort();
  const result = {};
  for (const name of childs) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      result[name] = 'file:' + await calcMd5ForFile(fullPath);
    } else {
      result[name] = 'directory:' + await calcMd5ForDirectory(fullPath);
    }
  }
  var hash = crypto.createHash('md5');
  hash.update(JSON.stringify(result), 'md5');
  return hash.digest('hex');
}

async function pack(dir, output){
  const hash = await calcMd5ForDirectory(dir);
  const realOutput = output.replace(/\$\{hash\}/g, hash);
  await mkdir(path.dirname(realOutput))
  await new Promise((resolve, reject) => {
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
    zipfile.outputStream.pipe(fs.createWriteStream(realOutput))
      .on("close", function() {
        resolve();
      });
    zipfile.end();
  });
  console.log('Bundled with hash: ' + hash);
}

function enumZipEntries(zipFn, callback) {
  return new Promise((resolve, reject) => {
    openZipFile(zipFn, {lazyEntries:true}, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
      zipfile.on('entry', entry => {
        const result = callback(entry, zipfile);
        if (result && typeof(result.then) === 'function') {
          result.then(() => zipfile.readEntry());
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.readEntry();
    });
  });
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
    } = translateOptions(options);

    if (!platform) {
      throw new Error('Platform must be specified.');
    }

    await mkdir(intermediaDir);

    const { version, major, minor } = getRNVersion();

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
  },

  async diff({args, options}) {
    const [origin, next] = args;
    const {output} = options;

    if (!origin || !next) {
      console.error('pushy diff <origin> <next>');
      process.exit(1);
    }

    //Read crc32 map from origin
    const originMap = {};
    const originEntries = {};

    await enumZipEntries(origin, entry => {
      if (!/\/$/.test(entry.fileName)) {
        // isFile
        originEntries[entry.fileName] = entry.crc32;
        originMap[entry.crc32] = entry.fileName;
      }
    });

    const copies = {};

    var zipfile = new ZipFile();

    const writePromise = new Promise((resolve, reject)=>{
      zipfile.outputStream.on('error', err => {throw err;});
      zipfile.outputStream.pipe(fs.createWriteStream(output))
        .on("close", function() {
          resolve();
        });
    });

    await enumZipEntries(next, (entry, nextZipfile) => {
      if (/\/$/.test(entry.fileName)) {
        // Directory
        zipfile.addEmptyDirectory(entry.fileName);
      } else {
        // If same file.
        if (originEntries[entry.fileName] === entry.crc32) {
          console.log('keep:', entry.fileName);
          copies[entry.fileName] = 1;
          return;
        }
        // If moved from other place
        if (originMap[entry.crc32]){
          console.log('move:' + originMap[entry.crc32] + '->' + entry.fileName);
          copies[entry.fileName] = originMap[entry.crc32];
          return;
        }

        // TODO: test diff
        console.log('add:' + entry.fileName);

        return new Promise((resolve, reject)=>{
          nextZipfile.openReadStream(entry, function(err, readStream) {
            if (err){
              return reject(err);
            }
            zipfile.addReadStream(readStream, entry.fileName);
            readStream.on('end', () => {
              console.log('add finished');
              resolve();
            });
          });
        })
      }
    });

    zipfile.addBuffer(new Buffer(JSON.stringify({copies})), '__diff.json');
    zipfile.end();
    await writePromise;
  }
};
