import { createContext, useContext } from 'react';
import { CheckResult, ProgressData } from './type';
import { Pushy } from './client';

const empty = {};
const noop = () => {};

export const defaultContext = {
  checkUpdate: () => Promise.resolve(empty),
  switchVersion: noop,
  switchVersionLater: noop,
  markSuccess: noop,
  dismissError: noop,
  downloadUpdate: noop,
  downloadAndInstallApk: noop,
  currentHash: '',
  packageVersion: '',
};

export const PushyContext = createContext<{
  checkUpdate: () => void;
  switchVersion: () => void;
  switchVersionLater: () => void;
  markSuccess: () => void;
  dismissError: () => void;
  downloadUpdate: () => void;
  downloadAndInstallApk: (url: string) => void;
  currentHash: string;
  packageVersion: string;
  client?: Pushy;
  progress?: ProgressData;
  updateInfo?: CheckResult;
  lastError?: Error;
}>(defaultContext);

export const usePushy = () => useContext(PushyContext);
