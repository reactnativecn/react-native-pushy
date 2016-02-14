/**
 * Created by tdzl2003 on 2/13/16.
 */

const fetch = require('isomorphic-fetch');
let host = process.env.PUSHY_REGISTRY || 'http://pushy.reactnative.cn';
const fs = require('fs-promise');

let session = undefined;
let savedSession = undefined;

exports.loadSession = async function() {
  if (await fs.exists('.pushy')) {
    try {
      exports.replaceSession(JSON.parse(await fs.readFile('.pushy', 'utf8')));
      savedSession = session;
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
  if (session !== savedSession) {
    const current = session;
    const data = JSON.stringify(current, null, 4);
    await fs.writeFile('.pushy', data, 'utf8');
    savedSession = current;
  }
}

exports.closeSession = async function(){
  if (await fs.exists('.pushy')) {
    await fs.unlink('.pushy');
    savedSession = undefined;
  }
  session = undefined;
  host = process.env.PUSHY_REGISTRY || 'http://pushy.reactnative.cn';
}

async function query(url, options) {
  const resp = await fetch(url, options);
  const json = await resp.json();
  if (resp.status !== 200) {
    throw Object.assign(new Error(json.message || json.error), {status: resp.status});
  }
  return json;
}

function queryWithoutBody(method) {
  return function(api) {
    return query(host + api, {
      method,
      headers: {
        'X-AccessToken': session ? session.token : '',
      },
    });
  };
}

function queryWithBody(method) {
  return function(api, body) {
    return query(host + api, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-AccessToken': session ? session.token : '',
      },
      body: JSON.stringify(body),
    });
  };
}

exports.get = queryWithoutBody('GET');
exports.post = queryWithBody('POST');
exports.put = queryWithBody('PUT');
