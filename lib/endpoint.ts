import { logger } from './utils';

let currentEndpoint = 'https://update.react-native.cn/api';
let backupEndpoints: string[] = ['https://update.reactnative.cn/api'];
let backupEndpointsQueryUrl: string | null = null;

export async function updateBackupEndpoints() {
  if (backupEndpointsQueryUrl) {
    try {
      const resp = await fetch(backupEndpointsQueryUrl);
      const remoteEndpoints = await resp.json();
      if (Array.isArray(remoteEndpoints)) {
        backupEndpoints = Array.from(
          new Set([...backupEndpoints, ...remoteEndpoints]),
        );
        logger('fetch remote endpoints:', remoteEndpoints);
        logger('merged backup endpoints:', backupEndpoints);
      }
    } catch (e) {
      logger('fetch remote endpoints failed');
    }
  }
  return backupEndpoints;
}

export function getCheckUrl(APPKEY, endpoint = currentEndpoint) {
  return `${endpoint}/checkUpdate/${APPKEY}`;
}

/**
 * @param {string} main - The main api endpoint
 * @param {string[]} [backups] - The back up endpoints.
 * @param {string} [backupQueryUrl] - An url that return a json file containing an array of endpoint.
 *                                    like: ["https://backup.api/1", "https://backup.api/2"]
 */
export function setCustomEndpoints({
  main,
  backups,
  backupQueryUrl,
}: {
  main: string;
  backups?: string[];
  backupQueryUrl?: string;
}) {
  currentEndpoint = main;
  backupEndpointsQueryUrl = null;
  if (Array.isArray(backups) && backups.length > 0) {
    backupEndpoints = backups;
  }
  if (typeof backupQueryUrl === 'string') {
    backupEndpointsQueryUrl = backupQueryUrl;
  }
}
