import { Fragment } from 'react';

const noop = () => {};
export class Pushy {
  constructor() {
    console.warn('react-native-update is not supported and will do nothing on web.');
    return new Proxy(this, {
      get() {
        return noop;
      },
    });
  }
}

export { PushyContext, usePushy } from './context';

export const PushyProvider = Fragment;
