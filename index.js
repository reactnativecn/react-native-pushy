/**
 * Created by tdzl2003 on 2/6/16.
 */

if (__DEV__){
  if (global.__fbBatchedBridge) {
    require('fbjs/lib/warning')('Should require pushy before react-native to do hook stuff!');
  }
}

require('./lib/hooks');
