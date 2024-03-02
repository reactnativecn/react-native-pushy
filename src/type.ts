export interface CheckResult {
  upToDate?: true;
  expired?: true;
  downloadUrl?: string;
  update?: true;
  name?: string; // version name
  hash?: string;
  description?: string;
  metaInfo?: string;
  pdiffUrl?: string;
  pdiffUrls?: string[];
  diffUrl?: string;
  diffUrls?: string[];
  updateUrl?: string;
  updateUrls?: string[];
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
  | 'errorUpdate'
  | 'markSuccess'
  | 'downloadingApk'
  | 'rejectStoragePermission'
  | 'errorStoragePermission'
  | 'errowDownloadAndInstallApk';

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
  queryUrl?: string;
}

export interface PushyOptions {
  appKey: string;
  server?: PushyServerConfig;
  logger?: UpdateEventsLogger;
  useAlert?: boolean;
  strategy?: 'onAppStart' | 'onAppResume' | 'both';
  autoMarkSuccess?: boolean;
  dismissErrorAfter?: number;
}
