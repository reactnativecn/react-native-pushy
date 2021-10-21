let currentEndpoint = 'https://update.react-native.cn/api';

function ping(url, rejectImmediate) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = (e) => {
      if (xhr.readyState !== 4) {
        return;
      }
      if (xhr.status === 200) {
        resolve(url);
      } else {
        rejectImmediate ? reject() : setTimeout(reject, 5000);
      }
    };
    xhr.open('HEAD', url);
    xhr.send();
    xhr.timeout = 5000;
    xhr.ontimeout = reject;
  });
}

function logger(...args) {
  // console.warn('pushy', ...args);
}

let backupEndpoints = [];
let backupEndpointsQueryUrl =
  'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-pushy@master/endpoints.json';

export async function tryBackupEndpoints() {
  if (!backupEndpoints.length && !backupEndpointsQueryUrl) {
    return;
  }
  try {
    await ping(getStatusUrl(), true);
    logger('current endpoint ok');
    return;
  } catch (e) {
    logger('current endpoint failed');
  }
  if (!backupEndpoints.length && backupEndpointsQueryUrl) {
    try {
      const resp = await fetch(backupEndpointsQueryUrl);
      backupEndpoints = await resp.json();
      logger('get remote endpoints:', backupEndpoints);
    } catch (e) {
      logger('get remote endpoints failed');
      return;
    }
  }
  await pickFatestAvailableEndpoint();
}

async function pickFatestAvailableEndpoint(endpoints = backupEndpoints) {
  const fastestEndpoint = await Promise.race(
    endpoints.map(pingAndReturnEndpoint),
  );
  if (typeof fastestEndpoint === 'string') {
    logger(`pick endpoint: ${fastestEndpoint}`);
    currentEndpoint = fastestEndpoint;
  } else {
    logger('all remote endpoints failed');
  }
}

async function pingAndReturnEndpoint(endpoint = currentEndpoint) {
  return ping(getStatusUrl(endpoint)).then(() => endpoint);
}

function getStatusUrl(endpoint = currentEndpoint) {
  return `${endpoint}/status`;
}

export function getCheckUrl(APPKEY, endpoint = currentEndpoint) {
  return `${endpoint}/checkUpdate/${APPKEY}`;
}

export function getReportUrl(endpoint = currentEndpoint) {
  return `${endpoint}/report`;
}

export function setCustomEndpoints({ main, backups, backupQueryUrl }) {
  currentEndpoint = main;
  backupEndpointsQueryUrl = null;
  if (Array.isArray(backups) && backups.length > 0) {
    backupEndpoints = backups;
    pickFatestAvailableEndpoint();
  }
  if (typeof backupQueryUrl === 'string') {
    backupEndpointsQueryUrl = backupQueryUrl;
  }
}
