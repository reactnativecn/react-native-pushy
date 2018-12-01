/**
 * Created by tdzl2003 on 2/22/16.
 */

import * as path from 'path';
import { mkdir as mkdirRecurisve } from 'mkdir-recursive';
import rmdirRecursive from 'rimraf';
import {
  getRNVersion,
  translateOptions,
} from './utils';
import * as fs from 'fs';
import {ZipFile} from 'yazl';
import {open as openZipFile} from 'yauzl';
// import {diff} from 'node-bsdiff';
import { question } from './utils';
import {checkPlatform} from './app';
import crypto from 'crypto';

var diff;
try {
  var bsdiff = require('node-bsdiff');
  diff = typeof bsdiff != 'function' ? bsdiff.diff : bsdiff;
} catch(e) {
  diff = function() {
    console.warn('This function needs "node-bsdiff". Please run "npm i node-bsdiff -S" from your project directory first!');
    throw new Error('This function needs module "node-bsdiff". Please install it first.')
  }
}

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

function rmdir(dir) {
  return new Promise((resolve, reject) => {
    rmdirRecursive(dir, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function pack(dir, output){
  await mkdir(path.dirname(output));
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
          //console.log('adding: ' + rel+name);
          zipfile.addFile(fullPath, rel+name);
        } else if (stat.isDirectory()) {
          //console.log('adding: ' + rel+name+'/');
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
  console.log('Bundled saved to: ' + output);
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
        prependListener() {

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

function basename(fn) {
  const m = /^(.+\/)[^\/]+\/?$/.exec(fn);
  return m && m[1];
}

async function diffFromPPK(origin, next, output) {
  await mkdir(path.dirname(output));

  const originEntries = {};
  const originMap = {};

  let originSource;

  await enumZipEntries(origin, (entry, zipFile) => {
    originEntries[entry.fileName] = entry;
    if (!/\/$/.test(entry.fileName)) {
      // isFile
      originMap[entry.crc32] = entry.fileName;

      if (entry.fileName === 'index.bundlejs') {
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

  const addedEntry = {};

  function addEntry(fn) {
    //console.log(fn);
    if (!fn || addedEntry[fn]) {
      return;
    }
    const base = basename(fn);
    if (base) {
      addEntry(base);
    }
    zipfile.addEmptyDirectory(fn);
  }

  const newEntries = {};

  await enumZipEntries(next, (entry, nextZipfile) => {
    newEntries[entry.fileName] = entry;

    if (/\/$/.test(entry.fileName)) {
      // Directory
      if (!originEntries[entry.fileName]) {
        addEntry(entry.fileName);
      }
    } else if (entry.fileName === 'index.bundlejs') {
      //console.log('Found bundle');
      return readEntire(entry, nextZipfile).then( newSource => {
        //console.log('Begin diff');
        zipfile.addBuffer(diff(originSource, newSource), 'index.bundlejs.patch');
        //console.log('End diff');
      });
    } else {
      // If same file.
      const originEntry = originEntries[entry.fileName];
      if (originEntry && originEntry.crc32 === entry.crc32) {
        // ignore
        return;
      }

      // If moved from other place
      if (originMap[entry.crc32]){
        const base = basename(entry.fileName);
        if (!originEntries[base]) {
          addEntry(base);
        }
        copies[entry.fileName] = originMap[entry.crc32];
        return;
      }

      // New file.
      addEntry(basename(entry.fileName));

      return new Promise((resolve, reject)=>{
        nextZipfile.openReadStream(entry, function(err, readStream) {
          if (err){
            return reject(err);
          }
          zipfile.addReadStream(readStream, entry.fileName);
          readStream.on('end', () => {
            //console.log('add finished');
            resolve();
          });
        });
      })
    }
  });

  const deletes = {};

  for (var k in originEntries) {
    if (!newEntries[k]) {
      console.log('Delete '+k);
      deletes[k] = 1;
    }
  }

  //console.log({copies, deletes});
  zipfile.addBuffer(new Buffer(JSON.stringify({copies, deletes})), '__diff.json');
  zipfile.end();
  await writePromise;
}

async function diffFromPackage(origin, next, output, originBundleName, transformPackagePath = v=>v) {
  await mkdir(path.dirname(output));

  const originEntries = {};
  const originMap = {};

  let originSource;

  await enumZipEntries(origin, (entry, zipFile) => {
    if (!/\/$/.test(entry.fileName)) {
      const fn = transformPackagePath(entry.fileName);
      if (!fn) {
        return;
      }

      //console.log(fn);
      // isFile
      originEntries[fn] = entry.crc32;
      originMap[entry.crc32] = fn;

      if (fn === originBundleName) {
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
      //console.log('Found bundle');
      return readEntire(entry, nextZipfile).then( newSource => {
        //console.log('Begin diff');
        zipfile.addBuffer(diff(originSource, newSource), 'index.bundlejs.patch');
        //console.log('End diff');
      });
    } else {
      // If same file.
      if (originEntries[entry.fileName] === entry.crc32) {
        copies[entry.fileName] = '';
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
            //console.log('add finished');
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
    const platform = checkPlatform(options.platform || await question('Platform(ios/android):'));

    let {
      entryFile,
      intermediaDir,
      output,
      dev,
      verbose
    } = translateOptions({...options, platform});

    const realIntermedia = path.resolve(intermediaDir);

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!platform) {
      throw new Error('Platform must be specified.');
    }

    const { version, major, minor } = getRNVersion();

    console.log('Bundling with React Native version: ', version);

    await rmdir(realIntermedia);
    await mkdir(realIntermedia);
    
    if (major === 0) {
      if (minor >= 56) {
        require('metro-babel-register');
      } else if (minor >= 52) {
        require('metro/src/babelRegisterOnly');
      } else if (minor >= 47) {
        require('metro-bundler/src/babelRegisterOnly');
      } else if (minor === 46) {
        require('metro-bundler/build/babelRegisterOnly');
      } else {
        // handle RN <= 0.45
        require(path.resolve('node_modules/react-native/packager/babelRegisterOnly'))([
          /private-cli\/src/,
          /local-cli/,
        ]);
      }
    }

    // This line fix issue #11
    require(path.resolve('node_modules/react-native/local-cli/cli'));

    const Config = require(path.resolve('node_modules/react-native/local-cli/util/Config'));
    const bundle = require(path.resolve('node_modules/react-native/local-cli/bundle/bundle'));
    let defaultConfig;

    if (major === 0) {
      if (minor >= 49) {
        entryFile = entryFile || `index.js`;
      } else {
        entryFile = entryFile || `index.${platform}.js`;
      }
    }

    if (major === 0) {
      if (minor >= 57) {
        // https://github.com/facebook/react-native/commit/a32620dc3b7a0ebd53feeaf7794051705d80f49e#diff-75692fe55c8b1a7c05f4264301342167L101
        // defaultConfig = Config.load();
        const { configPromise } = require(path.resolve('node_modules/react-native/local-cli/core'));
        defaultConfig = await configPromise;
      } else if (minor >= 45) {
        defaultConfig = Config.findOptional(path.resolve('.'));
      } else if (minor >= 42) {
        defaultConfig= Config.get(
          path.resolve('node_modules/react-native/local-cli'),
          require(path.resolve('node_modules/react-native/local-cli/core/default.config')),
          path.resolve('node_modules/react-native/packager/rn-cli.config.js'));
      } else if (minor >= 33) {
        defaultConfig= Config.get(
          path.resolve('node_modules/react-native/local-cli'),
          require(path.resolve('node_modules/react-native/local-cli/default.config')),
          path.resolve('node_modules/react-native/packager/rn-cli.config.js'));
      } else {
        defaultConfig= Config.get(path.resolve('node_modules/react-native/local-cli'), require(path.resolve('node_modules/react-native/local-cli/default.config')));
      }
    } else {
      defaultConfig = Config.findOptional(path.resolve('.'));
    }

    if (bundle.func) {
      // React native after 0.31.0
      await bundle.func([], defaultConfig, {
        entryFile : entryFile,
        platform: platform,
        dev: !!dev,
        bundleOutput: `${realIntermedia}${path.sep}index.bundlejs`,
        assetsDest: `${realIntermedia}`,
        verbose: !!verbose,
        bundleEncoding: 'utf8',
      });
    } else {
      // React native before 0.30.0
      await bundle([
        '--entry-file',
        entryFile,
        '--platform',
        platform,
        '--dev',
        '' + !!dev,
        '--bundle-output',
        `${realIntermedia}${path.sep}index.bundlejs`,
        '--assets-dest',
        `${realIntermedia}`,
        '--verbose',
        '' + !!verbose,
      ], defaultConfig);
    }

    console.log('Packing');

    await pack(realIntermedia, realOutput);

    const v = await question('Would you like to publish it?(Y/N)');
    if (v.toLowerCase() === 'y') {
      await this.publish({args: [realOutput], options: {
        platform,
      }})
    }
  },

  async diff({args, options}) {
    const [origin, next] = args;
    const {output} = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diff <origin> <next>');
      process.exit(1);
    }

    await diffFromPPK(origin, next, realOutput, 'index.bundlejs');
    console.log(`${realOutput} generated.`);
  },

  async diffFromApk({args, options}) {
    const [origin, next] = args;
    const {output} = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diffFromApk <origin> <next>');
      process.exit(1);
    }

    await diffFromPackage(origin, next, realOutput, 'assets/index.android.bundle');
    console.log(`${realOutput} generated.`);
  },

  async diffFromIpa({args, options}) {
    const [origin, next] = args;
    const {output} = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diffFromIpa <origin> <next>');
      process.exit(1);
    }

    await diffFromPackage(origin, next, realOutput, 'main.jsbundle', v=>{
      const m = /^Payload\/[^/]+\/(.+)$/.exec(v);
      return m && m[1];
    });

    console.log(`${realOutput} generated.`);
  },
};
