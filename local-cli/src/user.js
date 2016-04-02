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
  return crypto.createHash('md5').update(str).digest('hex');
}

exports.commands = {
  login: async function ({args}){
    const email = args[0] || await question('email:');
    const pwd = args[1] || await question('password:', true);
    const {token, info} = await post('/user/login', {
      email,
      pwd: md5(pwd),
    });
    replaceSession({token});
    await saveSession();
    console.log(`Welcome, ${info.name}.`);
  },
  logout: async function (){
    await closeSession();
    console.log('Logged out.');
  },
  me: async function (){
    const me = await get('/user/me');
    for (const k in me) {
      if (k !== 'ok') {
        console.log(`${k}: ${me[k]}`);
      }
    }
  },
}
