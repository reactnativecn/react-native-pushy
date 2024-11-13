import { Platform } from 'react-native';

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

export function logger(...args: any[]) {
  console.log('Pushy: ', ...args);
}

export function assertRelease() {
  if (__DEV__) {
    throw new Error('react-native-update 只能在 RELEASE 版本中运行.');
  }
}

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

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length) {
    return null;
  }
  return promiseAny(urls.map(ping)).catch(() => null);
};
