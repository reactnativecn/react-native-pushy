// var async = require('async');
var plist = require('simple-plist');
var decompress = require('decompress-zip');
// var provisioning = require('provisioning');
// var entitlements = require('entitlements');

var rimraf = require('rimraf');
var tmp = require('temporary');
var glob = require('glob');

var output = new tmp.Dir();

module.exports = function(file, callback) {
  var data = {};

  var unzipper = new decompress(file);
  unzipper.extract({
    path: output.path
  });

  unzipper.on('error', cleanUp);
  unzipper.on('extract', function() {
    var path = glob.sync(output.path + '/Payload/*/')[0];

    data.metadata = plist.readFileSync(path + 'Info.plist');

    cleanUp();
    /*
    var tasks = [async.apply(provisioning, path + 'embedded.mobileprovision')];

    // `entitlements` relies on a OS X only CLI tool called `codesign`
    if (process.platform === 'darwin') {
      tasks.push(async.apply(entitlements, path));
    }

    async.parallel(tasks, function(error, results) {
      if (error) {
        return cleanUp(error);
      }

      data.provisioning = results[0];

      // Hard to serialize and it looks messy in output
      delete data.provisioning.DeveloperCertificates;

      // Will be undefined on non-OSX platforms
      data.entitlements = results[1];

      return cleanUp();
    });
    */
  });

  function cleanUp(error) {
    rimraf.sync(output.path);
    return callback(error, data);
  }
};
