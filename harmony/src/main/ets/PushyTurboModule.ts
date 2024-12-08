import { TurboModule, TurboModuleContext } from 'rnoh/ts';
import common from '@ohos.app.ability.common';
import dataPreferences from '@ohos.data.preferences';
import geoLocationManager from '@ohos.geoLocationManager';
import { bundleManager } from '@kit.AbilityKit';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import { BusinessError } from '@ohos.base';
import { Config, GeolocationOptions } from './Config';
import { LocationManager } from './LocationManager';
import logger from './Logger';
import { UpdateModuleImpl } from './UpdateModuleImpl';
import { UpdateContext } from './UpdateContext';

const TAG = "PushyTurboModule"

export class PushyTurboModule extends TurboModule {
  mConfiguration: Config
  mUiCtx: common.UIAbilityContext
  context: UpdateContext
  mLocationManager: LocationManager

  constructor(protected ctx: TurboModuleContext) {
    super(ctx);
    logger.debug(TAG, ",PushyTurboModule constructor");
    this.mUiCtx = ctx.uiAbilityContext
    let rnInstance = ctx.rnInstance
    this.context = new UpdateContext(this.mUiCtx)
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
  const isUsingBundleUrl = this.context.getIsUsingBundleUrl();
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
    buildTime,
    isUsingBundleUrl,
    isFirstTime,
    rolledBackVersion,
    uuid,
  }
}


  async setLocalHashInfo(hash: string, info: string): Promise<boolean>  {
    logger.debug(TAG, ",call setLocalHashInfo");
    return UpdateModuleImpl.setLocalHashInfo(this.context,hash,info);
  }

  async getLocalHashInfo(hash: string): Promise<string> {
    return UpdateModuleImpl.getLocalHashInfo(this.context,hash);
  }

  async setUuid(uuid: string): Promise<boolean>  {
    logger.debug(TAG, `,call setUuid`);
    return UpdateModuleImpl.setUuid(this.context,uuid);
  }

  async reloadUpdate(options: { hash: string }): Promise<void> {
    logger.debug(TAG, `,call reloadUpdate`);
    return UpdateModuleImpl.reloadUpdate(this.context, this.mUiCtx, options);
  }

  async setNeedUpdate(options: { hash: string }): Promise<boolean> {
    logger.debug(TAG, `,call setNeedUpdate`);
    return UpdateModuleImpl.setNeedUpdate(this.context, options);
  }

  async markSuccess(): Promise<boolean> {
    logger.debug(TAG, `,call markSuccess`);
    return UpdateModuleImpl.markSuccess(this.context);
  }

  async downloadPatchFromPpk(options: { updateUrl: string; hash: string; originHash: string }): Promise<void> {
    logger.debug(TAG, `,call downloadPatchFromPpk`);
    return UpdateModuleImpl.downloadPatchFromPpk(this.context, options);
  }

  async downloadPatchFromPackage(options: { updateUrl: string; hash: string }): Promise<void>  {
    logger.debug(TAG, `,call downloadPatchFromPackage`);
    return UpdateModuleImpl.downloadPatchFromPackage(this.context, options);
  }

  async downloadFullUpdate(options: { updateUrl: string; hash: string }): Promise<void> {
    logger.debug(TAG, `,call downloadFullUpdate`);
    return UpdateModuleImpl.downloadFullUpdate(this.context, options);
  }

  async downloadAndInstallApk(options: { url: string; target: string; hash: string }): Promise<void> {
    logger.debug(TAG, `,call downloadAndInstallApk`);
    return UpdateModuleImpl.downloadAndInstallApk(this.context, options);
  }

  addListener(eventName: string): void {
    logger.debug(TAG, `,call addListener`);
  }

  removeListeners(count: number): void {
    logger.debug(TAG, `,call removeListeners`);
  }
}