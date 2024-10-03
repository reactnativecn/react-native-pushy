export interface CheckResult {
  upToDate?: true;
  expired?: true;
  downloadUrl?: string;
  update?: true;
  name?: string; // version name
  hash?: string;
  description?: string;
  metaInfo?: string;
  config?: {
    rollout?: {
      [packageVersion: string]: number;
    };
    [key: string]: any;
  };
  pdiff?: string;
  diff?: string;
  full?: string;
  paths?: string[];
  paused?: 'app' | 'package';
  message?: string;
}

export interface ProgressData {
  hash: string;
  received: number;
  total: number;
}

export type EventType =
  | 'rollback'
  | 'errorChecking'
  | 'checking'
  | 'downloading'
  | 'downloadSuccess'
  | 'errorUpdate'
  | 'markSuccess'
  | 'downloadingApk'
  | 'rejectStoragePermission'
  | 'errorStoragePermission'
  | 'errorDownloadAndInstallApk';

export interface EventData {
  currentVersion: string;
  cInfo: {
    pushy: string;
    rn: string;
    os: string;
    uuid: string;
  };
  packageVersion: string;
  buildTime: number;
  message?: string;
  rolledBackVersion?: string;
  newVersion?: string;
  [key: string]: any;
}

export type UpdateEventsLogger = ({
  type,
  data,
}: {
  type: EventType;
  data: EventData;
}) => void;

export interface PushyServerConfig {
  main: string;
  backups?: string[];
  queryUrls?: string[];
}

export interface PushyOptions {
  appKey: string;
  server?: PushyServerConfig;
  logger?: UpdateEventsLogger;
  updateStrategy?:
    | 'alwaysAlert'
    | 'alertUpdateAndIgnoreError'
    | 'silentAndNow'
    | 'silentAndLater'
    | null;
  checkStrategy?: 'onAppStart' | 'onAppResume' | 'both' | null;
  autoMarkSuccess?: boolean;
  dismissErrorAfter?: number;
  debug?: boolean;
  throwError?: boolean;
  beforeCheckUpdate?: () => Promise<boolean>;
  beforeDownloadUpdate?: (info: CheckResult) => Promise<boolean>;
}

export interface PushyTestPayload {
  type: '__rnPushyVersionHash' | string | null;
  data: any;
}
