import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { emptyModule, log } from './utils';
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;
const isTurboModuleEnabled = (global as any).__turboModuleProxy != null;

export const PushyModule =
  Platform.OS === 'web'
    ? emptyModule
    : isTurboModuleEnabled
    ? require('./NativePushy').default
    : NativeModules.Pushy;

if (!PushyModule) {
  throw new Error('react-native-update 模块无法加载，请对照安装文档检查配置。');
}

const PushyConstants = isTurboModuleEnabled
  ? PushyModule.getConstants()
  : PushyModule;
export const downloadRootDir: string = PushyConstants.downloadRootDir;
export const packageVersion: string = PushyConstants.packageVersion;
export const currentVersion: string = PushyConstants.currentVersion;
export const isFirstTime: boolean = PushyConstants.isFirstTime;
export const rolledBackVersion: string = PushyConstants.rolledBackVersion;
export const isRolledBack: boolean = typeof rolledBackVersion === 'string';

export const buildTime: string = PushyConstants.buildTime;
let uuid = PushyConstants.uuid;

if (Platform.OS === 'android' && !PushyConstants.isUsingBundleUrl) {
  throw new Error(
    'react-native-update 模块无法加载，请对照文档检查 Bundle URL 的配置',
  );
}

export function setLocalHashInfo(hash: string, info: Record<string, any>) {
  PushyModule.setLocalHashInfo(hash, JSON.stringify(info));
}

async function getLocalHashInfo(hash: string) {
  return JSON.parse(await PushyModule.getLocalHashInfo(hash));
}

export async function getCurrentVersionInfo(): Promise<{
  name?: string;
  description?: string;
  metaInfo?: string;
}> {
  return currentVersion ? (await getLocalHashInfo(currentVersion)) || {} : {};
}

export const pushyNativeEventEmitter = new NativeEventEmitter(PushyModule);

if (!uuid) {
  uuid = require('nanoid/non-secure').nanoid();
  PushyModule.setUuid(uuid);
}

log('uuid: ' + uuid);

export const cInfo = {
  pushy: require('../package.json').version,
  rn: RNVersion,
  os: Platform.OS + ' ' + Platform.Version,
  uuid,
};
