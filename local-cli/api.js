/**
 * Created by tdzl2003 on 2/13/16.
 */

const fetch = require('isomorphic-fetch');
const host = process.env.PUSHY_REGISTRY || 'http://pushy.reactnative.cn';
const fs = require('fs-promise');

let session = undefined;
let fileSession = undefined;

exports.loadSession = async function() {
  if (await fs.exists('.pushy')) {
    try {
      session = JSON.parse(await fs.readFile('.pushy', 'utf8'));
    } catch (e) {
      console.error('Failed to parse file `.pushy`. Try to remove it manually.');
      throw e;
    }
  }
}

exports.getSession = function(){
  return session;
}

exports.replaceSession = function(newSession) {
  session = newSession;
}

exports.saveSession = async function(){
  // Only save on change.
  if (session != fileSession) {
    const current = session;
    const data = JSON.stringify(current, null, 4);
    await fs.writeFile('.pushy', data, 'utf8');
    fileSession = current;
  }
}

function queryWithBody(method){
  return async function(api, body) {
    const resp = await fetch(host + api, {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'X-AccessToken': session ? session.token : '',
      },
      body: JSON.stringify(body),
    });
  }
}

exports.post = queryWithBody('POST');
exports.put = queryWithBody('PUT');
