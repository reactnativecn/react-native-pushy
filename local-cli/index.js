/**
 * Created by tdzl2003 on 2/13/16.
 */

const {loadSession} = require('./api');
const userCommands = require('./user').commands;

function printUsage({args}) {
  // const commandName = args[0];
  // TODO: print usage of commandName, or print global usage.

  console.log('Usage is under development now.')
  console.log('Visit `https://github.com/reactnativecn/react-native-pushy` for early document.');
  process.exit(1);
}

const commands = {
  ...userCommands,
  help: printUsage,
};

exports.run = function () {
  const argv = require('cli-arguments').parse(require('./cli.json'));

  loadSession()
    .then(()=>commands[argv.command](argv))
    .catch(err=>console.error(err.stack));
};
