export const downloadRootDir: string;
export const packageVersion: string;
export const currentVersion: string;
export const isFirstTime: boolean;
export const isRolledBack: boolean;

export interface ExpiredResult {
  upToDate?: false;
  expired: true;
  downloadUrl: string;
}

export interface UpTodateResult {
  expired?: false;
  upToDate: true;
  paused?: 'app' | 'package';
}

export interface UpdateAvailableResult {
  expired?: false;
  upToDate?: false;
  update: true;
  name: string; // version name
  hash: string;
  description: string;
  metaInfo: string;
  pdiffUrl: string;
  diffUrl?: string;
}

export type CheckResult =
  | ExpiredResult
  | UpTodateResult
  | UpdateAvailableResult;

export function checkUpdate(appkey: string): Promise<CheckResult>;

export function downloadUpdate(
  info: UpdateAvailableResult,
  eventListeners?: {
    onDownloadProgress?: (data: ProgressData) => void;
  },
): Promise<undefined | string>;

export function switchVersion(hash: string): void;

export function switchVersionLater(hash: string): void;

export function markSuccess(): void;

export function downloadAndInstallApk({
  url,
  onDownloadProgress,
}: {
  url: string;
  onDownloadProgress?: (data: ProgressData) => void;
}): Promise<void>;

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
}): void;

export function getCurrentVersionInfo(): Promise<{
  name?: string;
  description?: string;
  metaInfo?: string;
}>;

interface ProgressData {
  hash: string;
  received: number;
  total: number;
}

export function simpleUpdate(wrappedComponent: any): any;
