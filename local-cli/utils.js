/**
 * Created by tdzl2003 on 2/13/16.
 */

var read = require('read');

exports.question = function(query, password) {
  return new Promise((resolve, reject)=>read({
    prompt: query,
    silent: password,
    replace: password ? '*' : undefined,
  }, (err, result)=> err ? reject(err) : resolve(result)));
}