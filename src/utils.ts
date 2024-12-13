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
    : async (url: string) => {
        let pingFinished = false;
        return Promise.race([
          fetch(url, {
            method: 'HEAD',
          })
            .then(({ status, statusText }) => {
              pingFinished = true;
              if (status === 200) {
                return url;
              }
              log('ping failed', url, status, statusText);
              return null;
            })
            .catch(e => {
              pingFinished = true;
              log('ping error', url, e);
              return null;
            }),
          new Promise(r =>
            setTimeout(() => {
              r(null);
              if (!pingFinished) {
                log('ping timeout', url);
              }
            }, 2000),
          ),
        ]);
      };

export function joinUrls(paths: string[], fileName?: string) {
  if (fileName) {
    return paths.map(path => 'https://' + path + '/' + fileName);
  }
}

export const testUrls = async (urls?: string[]) => {
  if (!urls?.length) {
    return null;
  }
  const ret = await promiseAny(urls.map(ping));
  if (ret) {
    return ret;
  }
  log('all ping failed, use first url:', urls[0]);
  return urls[0];
};
