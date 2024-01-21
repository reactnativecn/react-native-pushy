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
};

export const PushyContext = createContext<{
  checkUpdate: () => void;
  switchVersion: () => void;
  switchVersionLater: () => void;
  progress?: ProgressData;
  markSuccess: () => void;
  updateInfo?: CheckResult;
  lastError?: Error;
  dismissError: () => void;
  client?: Pushy;
  downloadUpdate: () => void;
}>(defaultContext);

export const usePushy = () => useContext(PushyContext);
