#!/usr/bin/env node
/**
 * Created by tdzl2003 on 2/13/16.
 */

import * as path from 'path';
import * as fs from 'fs-promise';

const CLI_MODULE_PATH = function() {
  return path.resolve(
    process.cwd(),
    'node_modules',
    'react-native-update',
    'local-cli'
  );
};

const PACKAGE_JSON_PATH = function() {
  return path.resolve(
    process.cwd(),
    'node_modules',
    'react-native-update',
    'package.json'
  );
};

checkForVersionCommand();

let cli;
const cliPath = CLI_MODULE_PATH();
if (fs.existsSync(cliPath)) {
  cli = require(cliPath);
}

if (cli) {
  cli.run();
} else {
  console.error('Are you at home directory of a react-native project?');
  console.error('`pushy install` is under development, please run `npm install react-native-update` to install pushy manually.');
  process.exit(1);
}

function checkForVersionCommand() {
  if (process.argv.indexOf('-v') >= 0 || process.argv[2] === 'version') {
    console.log('react-native-update-cli: ' + require('../package.json').version);
    try {
      console.log('react-native-update: ' + require(PACKAGE_JSON_PATH()).version);
    } catch (e) {
      console.log('react-native-update: n/a - not inside a React Native project directory')
    }
    process.exit();
  }
}
