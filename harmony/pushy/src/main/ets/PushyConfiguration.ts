import NativePatchCore from './NativePatchCore';

/** Options accepted by PushyFileJSBundleProvider.configure(). */
export interface PushyConfiguration {
  appKey: string;
  /** Omitted: Pushy's built-in endpoints. Custom endpoints never inherit discovery URLs. */
  endpoints?: string[];
  queryUrls?: string[];
  /** Default: none. setNeedUpdate selects a downloaded bundle for the NEXT launch. */
  afterDownload?: 'none' | 'setNeedUpdate';
  disabled?: boolean;
  /** Omit to use the installed application's version. */
  packageVersion?: string;
  /** Optional telemetry version strings; not required to check or install an update. */
  rnu?: string;
  rn?: string;
}

/**
 * Pure validation, before any native state is touched. Does not mutate options.
 * The rules and defaults are the shared core's (cpp/update_flow_core
 * NormalizeConfiguration, also used by Android and iOS); it throws
 * Error("Invalid native configuration: ...") for options the host must fix.
 */
export function normalizePushyConfiguration(options: PushyConfiguration): string {
  return NativePatchCore.normalizeConfiguration(JSON.stringify(options));
}
