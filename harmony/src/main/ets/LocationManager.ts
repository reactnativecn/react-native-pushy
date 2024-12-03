import geoLocationManager from '@ohos.geoLocationManager';
import { BusinessError } from '@ohos.base';
import logger from './Logger';
import systemDateTime from '@ohos.systemDateTime';

const TAG: string = "LocationManager"
let rnIns_global = null
let cachePosition = null

const locationChangeListener = (location: geoLocationManager.Location) => {
  logger.debug(TAG, `locationChangeListener: data:${JSON.stringify(location)}`);
  let position = {
    coords: {
      latitude: location.latitude,
      longitude: location.longitude,
      altitude: location.altitude,
      accuracy: location.accuracy,
      heading: location.direction,
      speed: location.speed,
    },
    timeStamp: location.timeStamp,
  };
  logger.debug(TAG, `startObserving,emitDeviceEvent position:${position}`);
  rnIns_global.emitDeviceEvent("geolocationDidChange",position);
}

export class LocationManager {
  rnIns:any
  setRnInstance(rnInstance){
    this.rnIns = rnInstance
    rnIns_global = this.rnIns
  }
  /**
   * @param options
   * @param success
   * @param error
   */
  getCurrentLocationData(options, success, error): void {
    logger.debug(TAG, "getCurrentLocationData enter");

    let locationChange = (err: BusinessError, location: geoLocationManager.Location): void => {
      if (err) {
        logger.error(TAG, "getCurrentLocationData,locationChanger: err=" + JSON.stringify(err));
        error(err)
      }
      if (location) {
        logger.debug(TAG, "getCurrentLocationData,locationChanger,location=" + JSON.stringify(location));
        let position = {
          coords: {
            latitude: location.latitude,
            longitude: location.longitude,
            altitude: location.altitude,
            accuracy: location.accuracy,
            heading: location.direction,
            speed: location.speed,
          },
          timeStamp: location.timeStamp,
        }
        if(options.maximumAge > 0 || options.maximumAge == 'Infinity') {
          cachePosition = position
        }
        logger.debug(TAG, `getCurrentLocationData,locationChanger,before call success,position=${JSON.stringify(position)}`);
        success(position)
      }
    };

    let requestInfo: geoLocationManager.CurrentLocationRequest = {
      'priority': 0x203,
      'scenario': 0x300,
      'maxAccuracy': 0,
      'timeoutMs': 2000 };
    if (options) {
      if (options.timeout) {
        requestInfo.timeoutMs = options.timeout
      }
      if (options.enableHighAccuracy) {
        requestInfo.maxAccuracy = 0
      }
    }
    
    if(options.maximumAge == 0){
      try {
            geoLocationManager.getCurrentLocation(requestInfo, locationChange)
        } catch(e) {
          let err: BusinessError = e as BusinessError;
          error({errCode: err.code, errMessage:err.message});
        }
    }else {
      if(cachePosition == null) {
        try {
            geoLocationManager.getCurrentLocation(requestInfo, locationChange)
        } catch(e) {
          let err: BusinessError = e as BusinessError;
          error({errCode: err.code, errMessage:err.message});
        }
      }else {
        if(options.maximumAge == 'Infinity') {
          success(cachePosition)
        }
          
        if((new Date().getTime()  - cachePosition.timeStamp) <= options.maximumAge) {
            success(cachePosition)
          }else {
            cachePosition = null
            try {
              geoLocationManager.getCurrentLocation(requestInfo, locationChange)
            } catch(e) {
            let err: BusinessError = e as BusinessError;
            error({errCode: err.code, errMessage:err.message});
            }
          }
      }
    }
  }

  startObserving(requestInfo): void {
    logger.debug(TAG, ",startObserving enter");
    try {
      logger.debug(TAG, ",startObserving,on second");
      geoLocationManager.on('locationChange', requestInfo, locationChangeListener);
    } catch (error) {
      let err: BusinessError = error as BusinessError;
      rnIns_global.emitDeviceEvent("geolocationError",{code: err.code, message: err.message});
      logger.error(TAG, `startObserving,startObserving errCode:${err.code},errMessage:${err.message}`);
    }
  }

  stopObserving(): void {
    logger.debug(TAG, ",stopObserving enter");
    try {
      geoLocationManager.off('locationChange', locationChangeListener);
    } catch (error) {
      let err: BusinessError = error as BusinessError;
      logger.error(TAG, `,stopObserving,errCode:${err.code},errMessage:${err.message}`);
    }
  }
}
