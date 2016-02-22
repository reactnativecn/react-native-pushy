/**
 * Created by tdzl2003 on 2/13/16.
 */

import {question} from './utils';
const {
  post,
  get,
  replaceSession,
  saveSession,
  closeSession,
} = require('./api');
const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('base64');
}

exports.commands = {
  login: async function ({args}){
    const login = args[0] || await question('user:');
    const pwd = args[1] || await question('password:', true);
    const {token} = await post('/user/login', {
      login,
      pwd: md5(pwd),
    });
    replaceSession({token});
    await saveSession();
    console.log('OK.');
  },
  logout: async function (){
    await closeSession();
    console.log('Logged out.');
  },
  me: async function (){
    try {
      const me = await get('/user/me');
      console.log(me);
    } catch (e) {
      if (e.status === 401) {
        console.log('Not loggined.\nRun `pushy login` at your project directory to login.');
      } else {
        throw e;
      }
    }
  }
}
