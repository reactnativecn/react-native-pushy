/**
 * Created by tdzl2003 on 2/13/16.
 */

const {question} = require('./utils');

exports.commands = {
  login: async function ({args}){
    const username = args[0] || await question('user:');
    const password = args[1] || await question('password:', true);

  }
}