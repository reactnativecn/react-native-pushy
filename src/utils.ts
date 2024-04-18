export function log(...args: any[]) {
  console.log('pushy: ', ...args);
}


const ping = async (url: string) =>
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
