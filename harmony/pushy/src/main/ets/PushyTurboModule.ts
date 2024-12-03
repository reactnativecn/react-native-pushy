import { TurboModule, TurboModuleContext } from 'rnoh/ts';
import dataPreferences from '@ohos.data.preferences';
import geoLocationManager from '@ohos.geoLocationManager';
import { bundleManager } from '@kit.AbilityKit';
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
    // this.mLocationManager = new LocationManager()
    // this.mLocationManager.setRnInstance(rnInstance)
  }


getConstants(): Object {
  logger.debug(TAG, ",call getConstants");

  const context = this.mUiCtx;
  const preferencesManager = dataPreferences.getPreferencesSync(context,{ name: 'update' });
  const isFirstTime = preferencesManager.getSync("isFirstTime", false) as boolean;
  const rolledBackVersion = preferencesManager.getSync("rolledBackVersion", "") as string;
  const uuid = preferencesManager.getSync("uuid", "") as string;
  const currentVersion = preferencesManager.getSync("currentVersion", "") as string;
  const buildTime = preferencesManager.getSync("buildTime", "") as string;
  let bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_REQUESTED_PERMISSION;
  let packageVersion = '';
  try {
    const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleFlags);
    packageVersion = bundleInfo?.versionName || "Unknown"
  } catch (error) {
    console.error("Failed to get bundle info:", error);
  }

  if (isFirstTime) {
    preferencesManager.deleteSync("isFirstTime");
  }

  if (rolledBackVersion) {
    preferencesManager.deleteSync("rolledBackVersion");
  }

  return {
    downloadRootDir: `${context.filesDir}/_update`,
    packageVersion,
    currentVersion,
    isFirstTime,
    rolledBackVersion,
    buildTime,
    uuid,
    isUsingBundleUrl: true
  }
}


  setLocalHashInfo(hash: string, info: string): void {
    logger.debug(TAG, ",call requestAuthorization");
    // const permissions: Array<Permissions> = ['ohos.permission.APPROXIMATELY_LOCATION', 'ohos.permission.LOCATION'];
    // let onGrantedSuccess = () => {
    //   logger.debug(TAG, `,call requestAuthorization,onGranted ok:`);
    //   logger.debug(TAG, `,call requestAuthorization,onGranted before notify RN:`);
    //   success();
    // }
    // let onGrantedFailed = (errorB) => {
    //   logger.debug(TAG, `,call requestAuthorization,onGrantedFailed error: ${JSON.stringify(errorB)}`);
    //   error(errorB)
    // }
    // this.reqPermissionsFromUser(permissions, onGrantedSuccess, onGrantedFailed)
  }

  getLocalHashInfo(hash: string): void {
    // logger.debug(TAG, `,call getCurrentPosition`);
    // if (this.mConfiguration?.skipPermissionRequests) {
    //   logger.debug(TAG, `,call getCurrentPosition flag100`)
    //   this.mLocationManager.getCurrentLocationData(options, success, error);
    //   return;
    // }
    // logger.debug(TAG, `,call getCurrentPosition,to requestAuthorization ==req200`);
    // this.requestAuthorization(() => {
    //   this.mLocationManager.getCurrentLocationData(options, success, error)
    // }, error)
  }

  setUuid(uuid: string): void {
    logger.debug(TAG, `,call setUuid`);
  }

  reloadUpdate(options: { hash: string }): void {
    logger.debug(TAG, `,call reloadUpdate`);
  }

  setNeedUpdate(options: { hash: string }): void {
    logger.debug(TAG, `,call setNeedUpdate`);
  }

  markSuccess(): void {
    logger.debug(TAG, `,call markSuccess`);
  }

  downloadPatchFromPpk(options: { updateUrl: string; hash: string; originHash: string }): void {
    logger.debug(TAG, `,call downloadPatchFromPpk`);
  }

  downloadPatchFromPackage(options: { updateUrl: string; hash: string }): void {
    logger.debug(TAG, `,call downloadPatchFromPackage`);
  }

  downloadFullUpdate(options: { updateUrl: string; hash: string }): void {
    logger.debug(TAG, `,call downloadFullUpdate`);
  }

  downloadAndInstallApk(options: { url: string; target: string; hash: string }): void {
    logger.debug(TAG, `,call downloadAndInstallApk`);
  }

  addListener(eventName: string): void {
    logger.debug(TAG, `,call addListener`);
  }

  removeListeners(count: number): void {
    logger.debug(TAG, `,call removeListeners`);
  }
}