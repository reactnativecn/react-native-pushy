export const downloadRootDir: string;
export const packageVersion: string;
export const currentVersion: string;
export const isFirstTime: boolean;
export const isRolledBack: boolean;

export interface ExpiredResult {
  expired: true;
  downloadUrl: string;
}

export interface UpTodateResult {
  upToDate: true;
}

export interface UpdateAvailableResult {
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
  options: UpdateAvailableResult,
): Promise<undefined | string>;

export function switchVersion(hash: string): void;

export function switchVersionLater(hash: string): void;

export function markSuccess(): void;

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
  backUps?: string[];
  backupQueryUrl?: string;
}): void;


interface ProgressEvent {
  received: number;
  total: number;
}
