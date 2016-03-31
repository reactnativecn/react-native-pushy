/**
 * Created by tdzl2003 on 2/6/16.
 * @providesModule react-native-update
 */

//if (__DEV__){
//  if (global.__fbBatchedBridge) {
//    require('fbjs/lib/warning')('Should require pushy before react-native to do hook stuff!');
//  }
//}
//
//require('./lib/hooks');
const HotUpdate = require('react-native').NativeModules.HotUpdate;
const NativeAppEventEmitter = require('react-native').NativeAppEventEmitter;
const downloadRootDir = HotUpdate.downloadRootDir;

export function downloadFile(options) {
  HotUpdate.downloadUpdate(options, r=>{
    //console.log(r);
  })
}

export function reloadUpdate(options) {
  HotUpdate.reloadUpdate(options);
}

export function setNeedUpdate(options) {
  HotUpdate.setNeedUpdate(options);
}



