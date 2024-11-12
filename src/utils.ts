import { Platform } from 'react-native';

export function log(...args: any[]) {
  console.log('pushy: ', ...args);
}

export function promiseAny<T>(promises: Promise<T>[]) {
  return new Promise<T>((resolve, reject) => {
    let count = 0;

    promises.forEach(promise => {
      Promise.resolve(promise)
        .then(resolve)
        .catch(() => {
          count++;
          if (count === promises.length) {
            reject(new Error('All promises were rejected'));
          }
        });
    });
  });
}

export const emptyObj = {};
export const noop = () => {};
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
          }).then(({ status }) => (status === 200 ? url : null)),
          new Promise(r => setTimeout(() => r(null), 2000)),
        ]);

const canUseGoogle = ping('https://www.google.com');

export function joinUrls(paths: string[], fileName?: string) {
  if (fileName) {
    return paths.map(path => 'https://' + path + '/' + fileName);
  }
}

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length) {
    return null;
  }
  if (await canUseGoogle) {
    return urls[0];
  }
  return promiseAny(urls.map(ping)).catch(() => null);
};
