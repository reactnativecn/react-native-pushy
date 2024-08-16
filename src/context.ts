import { createContext, useContext } from 'react';
import { CheckResult, ProgressData } from './type';
import { Pushy } from './client';

const noop = () => {};
const asyncNoop = () => Promise.resolve();

export const defaultContext = {
  checkUpdate: asyncNoop,
  switchVersion: asyncNoop,
  switchVersionLater: asyncNoop,
  markSuccess: noop,
  dismissError: noop,
  downloadUpdate: asyncNoop,
  downloadAndInstallApk: asyncNoop,
  getCurrentVersionInfo: () => Promise.resolve({}),
  parseTestQrCode: () => false,
  currentHash: '',
  packageVersion: '',
};

export const PushyContext = createContext<{
  checkUpdate: () => Promise<void>;
  switchVersion: () => Promise<void>;
  switchVersionLater: () => Promise<void>;
  markSuccess: () => void;
  dismissError: () => void;
  downloadUpdate: () => Promise<void>;
  downloadAndInstallApk: (url: string) => Promise<void>;
  getCurrentVersionInfo: () => Promise<{
    name?: string;
    description?: string;
    metaInfo?: string;
  }>;
  parseTestQrCode: (code: string) => boolean;
  currentHash: string;
  packageVersion: string;
  client?: Pushy;
  progress?: ProgressData;
  updateInfo?: CheckResult;
  lastError?: Error;
}>(defaultContext);

export const usePushy = () => useContext(PushyContext);
