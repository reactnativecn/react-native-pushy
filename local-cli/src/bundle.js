/**
 * Created by tdzl2003 on 2/22/16.
 */

const path = require('path');
import { getRNVersion, translateOptions } from './utils';
import * as fs from 'fs-extra';
import { ZipFile } from 'yazl';
import { open as openZipFile } from 'yauzl';
import { question } from './utils';
import { checkPlatform } from './app';
const { spawn, spawnSync, execSync } = require('child_process');
const g2js = require('gradle-to-js/lib/parser');
const os = require('os');

var diff;
try {
  var bsdiff = require('node-bsdiff');
  diff = typeof bsdiff != 'function' ? bsdiff.diff : bsdiff;
} catch (e) {
  diff = function() {
    console.warn(
      'This function needs "node-bsdiff". Please run "npm i node-bsdiff" from your project directory first!',
    );
    throw new Error('This function needs module "node-bsdiff". Please install it first.');
  };
}

function exec(command) {
  const commandResult = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
  });
  if (commandResult.error) {
    throw commandResult.error;
  }
}

async function runReactNativeBundleCommand(
  bundleName,
  development,
  entryFile,
  outputFolder,
  platform,
  sourcemapOutput,
  config,
) {
  let reactNativeBundleArgs = [];

  let envArgs = process.env.PUSHY_ENV_ARGS;

  if (envArgs) {
    Array.prototype.push.apply(reactNativeBundleArgs, envArgs.trim().split(/\s+/));
  }

  fs.emptyDirSync(outputFolder);

  Array.prototype.push.apply(reactNativeBundleArgs, [
    path.join("node_modules", "react-native", "local-cli", "cli.js"), 
    "bundle",
    '--assets-dest',
    outputFolder,
    '--bundle-output',
    path.join(outputFolder, bundleName),
    '--dev',
    development,
    '--entry-file',
    entryFile,
    '--platform',
    platform,
    '--reset-cache',
  ]);

  if (sourcemapOutput) {
    reactNativeBundleArgs.push('--sourcemap-output', sourcemapOutput);
  }

  if (config) {
    reactNativeBundleArgs.push('--config', config);
  }

  const reactNativeBundleProcess = spawn('node', reactNativeBundleArgs);
  console.log(`Running bundle command: node ${reactNativeBundleArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    reactNativeBundleProcess.stdout.on('data', data => {
      console.log(data.toString().trim());
    });

    reactNativeBundleProcess.stderr.on('data', data => {
      console.error(data.toString().trim());
    });

    reactNativeBundleProcess.on('close', async exitCode => {
      if (exitCode) {
        reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
      } else {
        if (platform === 'android') {
          await compileHermesByteCode(bundleName, outputFolder);
        }
        resolve(null);
      }
    });
  });
}

function getHermesOSBin() {
  if (os.platform() === 'win32') return 'win64-bin';
  if (os.platform() === 'darwin') return 'osx-bin';
  if (os.platform() === 'linux') return 'linux64-bin';
}

async function compileHermesByteCode(bundleName, outputFolder) {
  let enableHermes = false;
  try {
    const gradleConfig = await g2js.parseFile('android/app/build.gradle');
    const projectConfig = gradleConfig['project.ext.react'];
    for (const packagerConfig of projectConfig) {
      if (packagerConfig.includes('enableHermes') && packagerConfig.includes('true')) {
        enableHermes = true;
        break;
      }
    }
  } catch (e) {}
  if (enableHermes) {
    console.log(`Hermes enabled, now compiling to hermes bytecode:\n`);
    const hermesPath = fs.existsSync('node_modules/hermes-engine')
      ? 'node_modules/hermes-engine'
      : 'node_modules/hermesvm';
    execSync(
      `${hermesPath}/${getHermesOSBin()}/hermes -emit-binary -out ${outputFolder}/${bundleName} ${outputFolder}/${bundleName} -O`,
      { stdio: 'ignore' },
    );
  }
}

async function pack(dir, output) {
  console.log('Packing');
  fs.ensureDirSync(path.dirname(output));
  await new Promise((resolve, reject) => {
    var zipfile = new ZipFile();

    function addDirectory(root, rel) {
      if (rel) {
        zipfile.addEmptyDirectory(rel);
      }
      const childs = fs.readdirSync(root);
      for (const name of childs) {
        if (name === '.' || name === '..') {
          continue;
        }
        const fullPath = path.join(root, name);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          //console.log('adding: ' + rel+name);
          zipfile.addFile(fullPath, rel + name);
        } else if (stat.isDirectory()) {
          //console.log('adding: ' + rel+name+'/');
          addDirectory(fullPath, rel + name + '/');
        }
      }
    }

    addDirectory(dir, '');

    zipfile.outputStream.on('error', err => reject(err));
    zipfile.outputStream.pipe(fs.createWriteStream(output)).on('close', function() {
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
        prependListener() {},
        on() {},
        once() {},
        emit() {},
      });
    });
  });
}

function basename(fn) {
  const m = /^(.+\/)[^\/]+\/?$/.exec(fn);
  return m && m[1];
}

async function diffFromPPK(origin, next, output) {
  fs.ensureDirSync(path.dirname(output));

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
        return readEntire(entry, zipFile).then(v => (originSource = v));
      }
    }
  });

  originSource = originSource || new Buffer(0);

  const copies = {};

  var zipfile = new ZipFile();

  const writePromise = new Promise((resolve, reject) => {
    zipfile.outputStream.on('error', err => {
      throw err;
    });
    zipfile.outputStream.pipe(fs.createWriteStream(output)).on('close', function() {
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
      return readEntire(entry, nextZipfile).then(newSource => {
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
      if (originMap[entry.crc32]) {
        const base = basename(entry.fileName);
        if (!originEntries[base]) {
          addEntry(base);
        }
        copies[entry.fileName] = originMap[entry.crc32];
        return;
      }

      // New file.
      addEntry(basename(entry.fileName));

      return new Promise((resolve, reject) => {
        nextZipfile.openReadStream(entry, function(err, readStream) {
          if (err) {
            return reject(err);
          }
          zipfile.addReadStream(readStream, entry.fileName);
          readStream.on('end', () => {
            //console.log('add finished');
            resolve();
          });
        });
      });
    }
  });

  const deletes = {};

  for (var k in originEntries) {
    if (!newEntries[k]) {
      console.log('Delete ' + k);
      deletes[k] = 1;
    }
  }

  //console.log({copies, deletes});
  zipfile.addBuffer(new Buffer(JSON.stringify({ copies, deletes })), '__diff.json');
  zipfile.end();
  await writePromise;
}

async function diffFromPackage(origin, next, output, originBundleName, transformPackagePath = v => v) {
  fs.ensureDirSync(path.dirname(output));

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
        return readEntire(entry, zipFile).then(v => (originSource = v));
      }
    }
  });

  originSource = originSource || new Buffer(0);

  const copies = {};

  var zipfile = new ZipFile();

  const writePromise = new Promise((resolve, reject) => {
    zipfile.outputStream.on('error', err => {
      throw err;
    });
    zipfile.outputStream.pipe(fs.createWriteStream(output)).on('close', function() {
      resolve();
    });
  });

  await enumZipEntries(next, (entry, nextZipfile) => {
    if (/\/$/.test(entry.fileName)) {
      // Directory
      zipfile.addEmptyDirectory(entry.fileName);
    } else if (entry.fileName === 'index.bundlejs') {
      //console.log('Found bundle');
      return readEntire(entry, nextZipfile).then(newSource => {
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
      if (originMap[entry.crc32]) {
        copies[entry.fileName] = originMap[entry.crc32];
        return;
      }

      return new Promise((resolve, reject) => {
        nextZipfile.openReadStream(entry, function(err, readStream) {
          if (err) {
            return reject(err);
          }
          zipfile.addReadStream(readStream, entry.fileName);
          readStream.on('end', () => {
            //console.log('add finished');
            resolve();
          });
        });
      });
    }
  });

  zipfile.addBuffer(new Buffer(JSON.stringify({ copies })), '__diff.json');
  zipfile.end();
  await writePromise;
}

function enumZipEntries(zipFn, callback) {
  return new Promise((resolve, reject) => {
    openZipFile(zipFn, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
      zipfile.on('entry', entry => {
        const result = callback(entry, zipfile);
        if (result && typeof result.then === 'function') {
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
  bundle: async function({ options }) {
    const platform = checkPlatform(options.platform || (await question('Platform(ios/android):')));

    let { bundleName, entryFile, intermediaDir, output, dev, verbose } = translateOptions({
      ...options,
      platform,
    });

    // const sourcemapOutput = path.join(intermediaDir, bundleName + ".map");

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!platform) {
      throw new Error('Platform must be specified.');
    }

    const { version, major, minor } = getRNVersion();

    console.log('Bundling with React Native version: ', version);

    await runReactNativeBundleCommand(bundleName, dev, entryFile, intermediaDir, platform);

    await pack(path.resolve(intermediaDir), realOutput);

    const v = await question('Would you like to publish it?(Y/N)');
    if (v.toLowerCase() === 'y') {
      await this.publish({
        args: [realOutput],
        options: {
          platform,
        },
      });
    }
  },

  async diff({ args, options }) {
    const [origin, next] = args;
    const { output } = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diff <origin> <next>');
      process.exit(1);
    }

    await diffFromPPK(origin, next, realOutput, 'index.bundlejs');
    console.log(`${realOutput} generated.`);
  },

  async diffFromApk({ args, options }) {
    const [origin, next] = args;
    const { output } = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diffFromApk <origin> <next>');
      process.exit(1);
    }

    await diffFromPackage(origin, next, realOutput, 'assets/index.android.bundle');
    console.log(`${realOutput} generated.`);
  },

  async diffFromIpa({ args, options }) {
    const [origin, next] = args;
    const { output } = options;

    const realOutput = output.replace(/\$\{time\}/g, '' + Date.now());

    if (!origin || !next) {
      console.error('pushy diffFromIpa <origin> <next>');
      process.exit(1);
    }

    await diffFromPackage(origin, next, realOutput, 'main.jsbundle', v => {
      const m = /^Payload\/[^/]+\/(.+)$/.exec(v);
      return m && m[1];
    });

    console.log(`${realOutput} generated.`);
  },
};
