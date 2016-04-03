/**
 * Created by tdzl2003 on 2/13/16.
 */

const fetch = require('isomorphic-fetch');
let host = process.env.PUSHY_REGISTRY || 'http://update.reactnative.cn';
const fs = require('fs-promise');
import * as fsOrigin from 'fs';
import request from 'request';
import ProgressBar from 'progress';

let session = undefined;
let savedSession = undefined;

exports.loadSession = async function() {
  if (await fs.exists('.update')) {
    try {
      exports.replaceSession(JSON.parse(await fs.readFile('.update', 'utf8')));
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
    await fs.writeFile('.update', data, 'utf8');
    savedSession = current;
  }
}

exports.closeSession = async function(){
  if (await fs.exists('.update')) {
    await fs.unlink('.update');
    savedSession = undefined;
  }
  session = undefined;
  host = process.env.PUSHY_REGISTRY || 'http://update.reactnative.cn';
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
exports.doDelete = queryWithBody('DELETE');

async function uploadFile(fn) {
  const {url, fieldName, formData} = await exports.post('/upload', {});
  let realUrl = url;

  if (!/^https?\:\/\//.test(url)) {
    url = host + url;
  }

  const fileSize = (await fs.stat(fn)).size;

  const bar = new ProgressBar('  Uploading [:bar] :percent :etas', {
    complete: '=',
    incomplete: ' ',
    total: fileSize,
  });

  const info = await new Promise((resolve, reject) => {
    formData.file = fsOrigin.createReadStream(fn);

    formData.file.on('data', function(data) {
      bar.tick(data.length);
    })
    request.post({
      url,
      formData,
    }, (err, resp, body) => {
      if (err) {
        return reject(err);
      }
      if (resp.statusCode > 299) {
        return reject(Object.assign(new Error(body), {status: resp.statusCode}));
      }
      resolve(JSON.parse(body));
    })
  });
  return info;
}

exports.uploadFile = uploadFile;