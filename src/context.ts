import { createContext, useContext } from 'react';
import { CheckResult, ProgressData } from './type';

const empty = {};
const noop = () => {};

export const defaultContext = {
  checkUpdate: () => Promise.resolve(empty),
  switchVersion: noop,
  switchVersionLater: noop,
  markSuccess: noop,
  dismissError: noop,
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
}>(defaultContext);

export const usePushy = () => useContext(PushyContext);
