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
    ? () => Promise.resolve(true)
    : async (url: string) =>
        Promise.race([
          fetch(url, {
            method: 'HEAD',
          }).then(({ status }) => status === 200),
          new Promise<false>(r => setTimeout(() => r(false), 2000)),
        ]);

const canUseGoogle = ping('https://www.google.com');

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length || (await canUseGoogle)) {
    return null;
  }
  return Promise.race(urls.map(url => ping(url).then(() => url))).catch(
    () => null,
  );
};
