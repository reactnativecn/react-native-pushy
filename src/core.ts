import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { EmptyModule, log } from './utils';
const {
  version: v,
} = require('react-native/Libraries/Core/ReactNativeVersion');
const RNVersion = `${v.major}.${v.minor}.${v.patch}`;
const isTurboModuleEnabled =
  // @ts-expect-error
  global.__turboModuleProxy != null;

export const PushyModule =
  Platform.OS === 'web'
    ? new EmptyModule()
    : isTurboModuleEnabled
    ? require('./NativePushy').default
    : NativeModules.Pushy;

if (!PushyModule) {
  throw new Error('react-native-update模块无法加载，请对照安装文档检查配置。');
}

const PushyConstants = isTurboModuleEnabled
  ? PushyModule.getConstants()
  : PushyModule;

export const downloadRootDir = PushyConstants.downloadRootDir;
export const packageVersion = PushyConstants.packageVersion;
export const currentVersion = PushyConstants.currentVersion;
export const isFirstTime = PushyConstants.isFirstTime;
export const rolledBackVersion = PushyConstants.rolledBackVersion;
export const isRolledBack = typeof rolledBackVersion === 'string';

export const buildTime = PushyConstants.buildTime;
let uuid = PushyConstants.uuid;

if (Platform.OS === 'android' && !PushyConstants.isUsingBundleUrl) {
  throw new Error(
    'react-native-update模块无法加载，请对照文档检查Bundle URL的配置',
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
