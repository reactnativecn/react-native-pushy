/**
 * Created by tdzl2003 on 2/13/16.
 */

const {loadSession} = require('./api');
const userCommands = require('./user').commands;
import {commands as bundleCommands} from './bundle';

function printUsage({args}) {
  // const commandName = args[0];
  // TODO: print usage of commandName, or print global usage.

  console.log('Usage is under development now.')
  console.log('Visit `https://github.com/reactnativecn/react-native-pushy` for early document.');
  process.exit(1);
}

const commands = {
  ...userCommands,
  ...bundleCommands,
  help: printUsage,
};

function translateOptions(options){
  for (let key in options) {
    const v = options[key];
    if (typeof(v) === 'string') {
      options[key] = v.replace(/\$\{(\w+)\}/, function (v, n){
        return options[n] || process.env[n] || v;
      })
    }
  }
}

exports.run = function () {
  const argv = require('cli-arguments').parse(require('../cli.json'));

  translateOptions(argv.options);

  loadSession()
    .then(()=>commands[argv.command](argv))
    .catch(err=>{
      setTimeout(()=>{
        throw err;
      });
    });
};
