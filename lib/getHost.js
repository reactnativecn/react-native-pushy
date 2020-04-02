let availableDomain = 'update.react-native.cn';

function ping(domain, rejectImmediate) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = e => {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status === 200) {
        resolve(domain);
      } else {
        rejectImmediate ? reject() : setTimeout(reject, 5000);
      }
    };
    xhr.open('HEAD', `https://${domain}`);
    xhr.send();
    xhr.timeout = 5000;
    xhr.ontimeout = reject;
  });
}

function logger(...args) {
  // console.warn('pushy', ...args);
}

export async function tryBackupDomains() {
  try {
    await ping(availableDomain, true);
    logger('main domain ok');
    return;
  } catch (e) {
    logger('main domain failed');
  }
  let backupDomains = [];
  try {
    const resp = await fetch(
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-pushy@master/domains.json',
    );
    backupDomains = await resp.json();
    logger('get remote domains:', backupDomains);
  } catch (e) {
    logger('get remote domains failed');
    return;
  }
  const fastestDomain = await Promise.race(backupDomains.map(ping));
  if (typeof fastestDomain === 'string') {
    logger(`pick domain: ${fastestDomain}`);
    availableDomain = fastestDomain;
  } else {
    logger('all remote domains failed');
  }
}

export default function getHost() {
  return `https://${availableDomain}/api`;
}
