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
import {diff} from 'node-bsdiff';

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

async function pack(dir, output){
  const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());
  await mkdir(path.dirname(realOutput));
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
  console.log('Bundled saved to: ' + realOutput);
}

function readEntire(entry, zipFile) {
  const buffers = [];
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      stream.pipe({
        write(chunk) {
          buffers.push(chunk);
        },
        end() {
          resolve(Buffer.concat(buffers));
        },
        on() {
        },
        once() {
        },
        emit() {
        },
      })
    });
  })
}

async function diffWithApk(origin, next, output) {
  const originEntries = {};
  const originMap = {};

  let originSource;

  await enumZipEntries(origin, (entry, zipFile) => {
    if (!/\/$/.test(entry.fileName)) {
      // isFile
      originEntries[entry.fileName] = entry.crc32;
      originMap[entry.crc32] = entry.fileName;

      if (entry.fileName === 'assets/index.android.bundle') {
        // This is source.
        return readEntire(entry, zipFile).then(v=>originSource = v);
      }
    }
  });

  originSource = originSource || new Buffer(0);

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
    } else if (entry.fileName === 'index.bundlejs') {
      console.log('Found bundle');
      return readEntire(entry, nextZipfile).then( newSource => {
        console.log('Begin diff');
        zipfile.addBuffer(diff(originSource, newSource), 'index.bundlejs.patch');
        console.log('End diff');
      });
    } else {
      // If same file.
      if (originEntries[entry.fileName] === entry.crc32) {
        copies[entry.fileName] = 1;
        return;
      }
      // If moved from other place
      if (originMap[entry.crc32]){
        copies[entry.fileName] = originMap[entry.crc32];
        return;
      }

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

  console.log(copies);
  zipfile.addBuffer(new Buffer(JSON.stringify({copies})), '__diff.json');
  zipfile.end();
  await writePromise;
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
          copies[entry.fileName] = 1;
          return;
        }
        // If moved from other place
        if (originMap[entry.crc32]){
          copies[entry.fileName] = originMap[entry.crc32];
          return;
        }

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
  },

  async diffWithApk({args, options}) {
    const [origin, next] = args;
    const {output} = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diffWithApk <origin> <next>');
      process.exit(1);
    }

    await diffWithApk(origin, next, realOutput);

  },
};
