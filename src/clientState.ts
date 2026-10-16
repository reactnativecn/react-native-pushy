import type { ProgressData } from './type';

export interface SharedState {
  downloadingTasks: Record<string, Promise<string | undefined>>;
  // Progress callbacks per hash: concurrent downloadUpdate callers of the
  // same hash each register theirs here instead of the second one being
  // silently dropped by the in-flight dedup.
  progressCallbacks: Record<string, Set<(data: ProgressData) => void>>;
  downloadedHash?: string;
  toHash?: string;
  apkStatus: 'downloading' | 'downloaded' | null;
  marked: boolean;
  applyingUpdate: boolean;
}

/**
 * Process-wide state of the update flow. The SDK is a process-level
 * singleton (one client, see Pushy's constructor); client.ts creates this
 * once, when it is evaluated, and hands it to each part of the client.
 */
export interface ProcessState {
  shared: SharedState;
  // The native cold-start check writes its response cache at most once per
  // launch (and skips it once JS has checked), so once this process has seen
  // it absent or expired, later reads are near-certain misses: skip the
  // bridge call from then on. The rare miss costs one network check. A fresh
  // entry that only mismatches the request or config does not set this: a
  // later check with the original options (e.g. after `extra` reverts) can
  // still reuse it.
  nativeCheckCacheExhausted: boolean;
  // In-flight native markSuccess shared by concurrent callers, so the native
  // call and its telemetry happen once. Cleared once settled.
  markingPromise?: Promise<void>;
  // A reset/new switch invalidates ownership of older async completions and
  // watchdogs before the process-wide applyingUpdate flag can be reused.
  applyingUpdateGeneration: number;
  reloadWatchdogTimer?: ReturnType<typeof setTimeout>;
}

export const createProcessState = (): ProcessState => ({
  shared: {
    downloadingTasks: {},
    progressCallbacks: {},
    downloadedHash: undefined,
    apkStatus: null,
    marked: false,
    applyingUpdate: false,
  },
  nativeCheckCacheExhausted: false,
  applyingUpdateGeneration: 0,
});
