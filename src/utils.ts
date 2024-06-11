import { Platform } from 'react-native';

export function log(...args: any[]) {
  console.log('pushy: ', ...args);
}

const noop = () => {};
class EmptyModule {
  constructor() {
    return new Proxy(this, {
      get() {
        return noop;
      },
    });
  }
}
export const emptyModule = new EmptyModule();

const ping =
  Platform.OS === 'web'
    ? Promise.resolve
    : async (url: string) =>
        Promise.race([
          fetch(url, {
            method: 'HEAD',
          })
            .then(({ status }) => (status === 200 ? url : null))
            .catch(() => null),
          new Promise(r => setTimeout(() => r(null), 2000)),
        ]);

const canUseGoogle = ping('https://www.google.com');

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length || (await canUseGoogle)) {
    return null;
  }
  return Promise.race(urls.map(ping)).catch(() => null);
};
