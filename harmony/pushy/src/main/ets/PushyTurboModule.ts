import { TurboModule, TurboModuleContext } from 'rnoh/ts';
import geoLocationManager from '@ohos.geoLocationManager';
import bundleManager from '@ohos.bundle.bundleManager';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import { BusinessError } from '@ohos.base';
import { Config, GeolocationOptions } from './Config';
import { LocationManager } from './LocationManager';
import logger from './Logger';

const TAG = "PushyTurboModule"

export class PushyTurboModule extends TurboModule {
  mConfiguration: Config
  mUiCtx: Context
  mLocationManager: LocationManager

  constructor(protected ctx: TurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ",PushyTurboModule constructor");
    this.mUiCtx = ctx.uiAbilityContext
    let rnInstance = ctx.rnInstance
    this.mLocationManager = new LocationManager()
    this.mLocationManager.setRnInstance(rnInstance)
  }

  setConfiguration(config: {
    skipPermissionRequests: boolean;
    authorizationLevel?: string;
    enableBackgroundLocationUpdates?: string;
  }): void {
    logger.debug(TAG, ",call setConfiguration");
    logger.debug(TAG, `,setConfigurationParam:${config.skipPermissionRequests}`);
    this.mConfiguration = config;
  }

  requestAuthorization(
    success: () => void,
    error: (error) => void
  ): void {
    logger.debug(TAG, ",call requestAuthorization");
    const permissions: Array<Permissions> = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    let onGrantedSuccess = () => {
      logger.debug(TAG, `,call requestAuthorization,onGranted ok:`);
      logger.debug(TAG, `,call requestAuthorization,onGranted before notify RN:`);
      success();
    }
    let onGrantedFailed = (errorB) => {
      logger.debug(TAG, `,call requestAuthorization,onGrantedFailed error: ${JSON.stringify(errorB)}`);
      error(errorB)
    }
    this.reqPermissionsFromUser(permissions, onGrantedSuccess, onGrantedFailed)
  }

  getCurrentPosition(
    options: GeolocationOptions,
    success: (position) => void,
    error: (error) => void
  ): void {
    logger.debug(TAG, `,call getCurrentPosition`);
    if (this.mConfiguration?.skipPermissionRequests) {
      logger.debug(TAG, `,call getCurrentPosition flag100`)
      this.mLocationManager.getCurrentLocationData(options, success, error);
      return;
    }
    logger.debug(TAG, `,call getCurrentPosition,to requestAuthorization ==req200`);
    this.requestAuthorization(() => {
      this.mLocationManager.getCurrentLocationData(options, success, error)
    }, error)
  }

  startObserving(options): void {
    logger.debug(TAG, `,call startObserving`);
    let requestInfo: geoLocationManager.LocationRequest = {
      'priority': 0x203,
      'scenario': 0x300,
      'timeInterval': 1,
      'distanceInterval': 0,
      'maxAccuracy': 0,
    };

    if (options.interval!=null) {
      requestInfo.timeInterval = options.interval / 1000
    }
    if (options.distanceFilter!=null) {
      requestInfo.distanceInterval = options.distanceFilter
    } else {
      requestInfo.distanceInterval = 0
    }

    this.mLocationManager.startObserving(requestInfo)
  }

  stopObserving(): void {
    logger.debug(TAG, `,call stopObserving`);
    this.mLocationManager.stopObserving()
  }

  addListener(eventName: string): void {
    logger.debug(TAG, `,call addListener`);
  }

  removeListeners(count: number): void {
    logger.debug(TAG, `,call removeListeners`);
  }

  async checkAccessToken(permission: Permissions): Promise<abilityAccessCtrl.GrantStatus> {
    let atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    let grantStatus: abilityAccessCtrl.GrantStatus = abilityAccessCtrl.GrantStatus.PERMISSION_DENIED;
    let tokenId: number = 0;
    try {
      let bundleInfo: bundleManager.BundleInfo = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      let appInfo: bundleManager.ApplicationInfo = bundleInfo.appInfo;
      tokenId = appInfo.accessTokenId;
    } catch (error) {
      let err: BusinessError = error as BusinessError;
      logger.error(TAG, `checkAccessToken,Failed to get bundle info for self. Code is ${err.code}, message is ${err.message}`);
    }
    try {
      grantStatus = await atManager.checkAccessToken(tokenId, permission);
    } catch (error) {
      let err: BusinessError = error as BusinessError;
      logger.error(TAG, `checkAccessToken,Failed to check access token. Code is ${err.code}, message is ${err.message}`);
    }
    return grantStatus;
  }

  async checkPermissions(): Promise<boolean> {
    const permissions: Array<Permissions> = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    logger.debug(TAG, `checkPermissions,flag100`);
    let grantStatus: abilityAccessCtrl.GrantStatus = await this.checkAccessToken(permissions[0]);
    logger.debug(TAG, `checkPermissions,flag200`);
    let grantStatus2: abilityAccessCtrl.GrantStatus = await this.checkAccessToken(permissions[1]);
    logger.debug(TAG, `checkPermissions,flag300`);
    if (grantStatus === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      && grantStatus2 === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
      logger.debug(TAG, `checkPermissions,flag500`);
      return true
    } else {
      return false
    }
  }

  reqPermissionsFromUser(permissions: Array<Permissions>, onGrantedSuccess: () => void, onGrantedFailed: (error) => void): void {
    let context: Context = this.mUiCtx
    let atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    atManager.requestPermissionsFromUser(context, permissions).then((data) => {
      let grantStatus: Array<number> = data.authResults;
      let length: number = grantStatus.length;
      let grantedCount = 0;
      for (let i = 0; i < length; i++) {
        if (grantStatus[i] === 0) {
          logger.debug(TAG, `,reqPermissionsFromUser,granted true: ${i}`);
          grantedCount++;
        } else {
          logger.debug(TAG, `,reqPermissionsFromUser,granted false: ${i}`);
        }
      }
      if (grantedCount == permissions.length) {
        logger.debug(TAG, `,reqPermissionsFromUser,granted ok100`);
        onGrantedSuccess()
      } else {
        onGrantedFailed({ message: "部分权限未获授权" });
      }
    }).catch((err: BusinessError) => {
      onGrantedFailed({code: err.code, message: err.message})
      logger.error(TAG, `,reqPermissionsFromUser,Failed to request permissions from user. Code is ${err.code}, message is ${err.message}`);
    })
  }
}