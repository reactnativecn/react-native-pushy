import { cInfo, nativeMethod } from './core';
import type { ClientOptions } from './type';
import { log } from './utils';

/** What the native config sync needs from the client. */
export interface NativeConfigHost {
  readonly options: ClientOptions;
  getEffectivePackageVersion(): string;
}

/**
 * Keeps the config the native cold-start check runs with
 * (NATIVE_CHECKUPDATE_DESIGN §10.1) in step with the client options, and
 * tells native when JS already holds a check response for it (§10.3).
 */
export class NativeConfigSync {
  constructor(private readonly host: NativeConfigHost) {}

  private syncedNativeConfigJson?: string;
  private pendingNativeConfigJson?: string;
  private nativeConfigSyncInFlight = false;
  // Config last acknowledged by markJsCheckCompleted.
  private jsCheckCompletedConfigJson?: string;

  /** Build the subset of options used by the native cold-start check. */
  private getNativeConfig = (): Record<string, unknown> | undefined => {
    if (!nativeMethod('syncNativeConfig')) {
      // Web, or an older native without the native check.
      return undefined;
    }
    const {
      appKey,
      server,
      updateStrategy,
      checkStrategy,
      disableNativeCheck,
    } = this.host.options;
    if (disableNativeCheck) {
      // Explicit opt-out: keep the identity fields so the persisted config
      // still describes this app, and let the orchestrators bail on `disabled`
      // before any IO.
      return { disabled: true, appKey, rnu: cInfo.rnu, rn: cInfo.rn };
    }
    if (!appKey || !server?.main?.length) {
      // Unusable rather than merely absent: the JS check would fail on these
      // options too (NO_ENDPOINTS / APPKEY_REQUIRED). The caller turns this
      // into an explicit disabled state.
      return undefined;
    }
    // An app that turned automatic checks off (checkStrategy: null) must not
    // be handed a version switch it never asked for. The cold-start check
    // still runs and still downloads — that is what keeps a bricked device
    // rescuable — but activation waits for the JS side, or for the server's
    // explicit per-version forceBoot directive (shouldActivateAfterDownload).
    const autoCheckEnabled = checkStrategy != null;
    return {
      appKey,
      packageVersion: this.host.getEffectivePackageVersion(),
      endpoints: server.main,
      queryUrls: server.queryUrls ?? [],
      // The native check may activate a downloaded version (next launch)
      // only under the silent strategies; alert-style strategies keep
      // activation with the JS side (§6/§10.1).
      afterDownload:
        autoCheckEnabled &&
        (updateStrategy === 'silentAndNow' ||
          updateStrategy === 'silentAndLater')
          ? 'setNeedUpdate'
          : 'none',
      rnu: cInfo.rnu,
      rn: cInfo.rn,
    };
  };

  getNativeConfigJson = (): string | undefined => {
    const config = this.getNativeConfig();
    return config ? JSON.stringify(config) : undefined;
  };

  private flushNativeConfig = () => {
    if (this.host.options.nativeConfigSource === 'native') {
      this.pendingNativeConfigJson = undefined;
      this.syncedNativeConfigJson = undefined;
      return;
    }
    const sync = nativeMethod('syncNativeConfig');
    if (!sync || this.nativeConfigSyncInFlight) {
      return;
    }
    const configJson = this.pendingNativeConfigJson;
    this.pendingNativeConfigJson = undefined;
    if (!configJson || configJson === this.syncedNativeConfigJson) {
      return;
    }
    this.nativeConfigSyncInFlight = true;
    sync(configJson)
      .then(() => {
        // A switch to 'native' while this write was in flight hands storage
        // to the host; remembering the write would skip it after switching
        // back.
        if (this.host.options.nativeConfigSource !== 'native') {
          this.syncedNativeConfigJson = configJson;
        }
      })
      .catch((e: any) => {
        log('syncNativeConfig failed:', e?.message || e);
      })
      .finally(() => {
        this.nativeConfigSyncInFlight = false;
        this.flushNativeConfig();
      });
  };

  /**
   * Tell the native cold-start orchestrator that this process already holds a
   * valid check response for the current config, so its delayed round (5s
   * after launch) does not repeat the request. Fire-and-forget: a failure
   * costs one duplicate check. Never called on a failed check — the native
   * rescue must keep running when JS could not reach the server.
   */
  markJsCheckCompleted = () => {
    const markCompleted = nativeMethod('markJsCheckCompleted');
    if (!markCompleted) {
      return;
    }
    const configJson = this.getNativeConfigJson();
    if (!configJson || configJson === this.jsCheckCompletedConfigJson) {
      return;
    }
    markCompleted(configJson).then(
      () => {
        this.jsCheckCompletedConfigJson = configJson;
      },
      (e: any) => {
        log('markJsCheckCompleted failed:', e?.message || e);
      }
    );
  };

  syncNativeConfig = () => {
    if (this.host.options.nativeConfigSource === 'native') {
      // The host owns the stored config now; forget what JS last wrote so a
      // switch back to 'javascript' writes again instead of deduping
      // against a value native storage no longer holds.
      this.pendingNativeConfigJson = undefined;
      this.syncedNativeConfigJson = undefined;
      return;
    }
    if (!nativeMethod('syncNativeConfig')) {
      return;
    }
    const configJson = this.getNativeConfigJson();
    if (!configJson) {
      // No usable config (empty appKey / no endpoints) is almost always a
      // transient state while options are being assembled. Persisting a
      // disabled config over the last good one would switch off the
      // cold-start rescue for every later launch, so keep what native has.
      // (Web and older natives never reach this point — no method.)
      log('native check config unusable, keeping the last synced config');
      return;
    }
    // Always record the latest desired value, even when it matches the last
    // completed write. Example: A synced -> B in flight -> options revert to
    // A. Comparing only with synced(A) would drop the revert and leave native
    // storage at B after that in-flight write completes.
    // Coalesce rapid setOptions calls, but serialize bridge writes so an older
    // completion can never overwrite the newest desired configuration.
    this.pendingNativeConfigJson = configJson;
    this.flushNativeConfig();
  };
}
