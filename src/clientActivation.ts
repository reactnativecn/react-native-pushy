import type { Pushy } from './client';
import type { Reporter } from './clientReporter';
import type { ProcessState } from './clientState';
import {
  currentVersionInfo,
  isFirstTime,
  nativeMethod,
  PushyModule,
} from './core';
import { UpdateError } from './error';
import type { BeforeReloadContext } from './type';
import { assertWeb, log } from './utils';

// How long after a resolved reloadUpdate the process may still be alive before
// the switch is considered not to have restarted the app (see switchVersion).
const RELOAD_WATCHDOG_MS = 5000;

/**
 * What activation needs from the client. Its public members are called
 * through the client, so a caller that replaces one on the instance sees
 * every use.
 */
export type ActivationHost = Pick<
  Pushy,
  | 'options'
  | 't'
  | 'assertDebug'
  | 'report'
  | 'throwIfEnabled'
  | 'runBeforeReload'
  | 'restartApp'
>;

/**
 * Everything that changes which version runs: markSuccess, switching to a
 * downloaded version (now or next launch), restarting and resetting to the
 * packaged bundle.
 */
export class Activation {
  constructor(
    private readonly host: ActivationHost,
    private readonly reporter: Reporter,
    private readonly state: ProcessState
  ) {}

  private clearReloadWatchdog = () => {
    if (this.state.reloadWatchdogTimer !== undefined) {
      clearTimeout(this.state.reloadWatchdogTimer);
      this.state.reloadWatchdogTimer = undefined;
    }
  };

  private beginApplyingUpdate = (): number => {
    this.clearReloadWatchdog();
    this.state.shared.applyingUpdate = true;
    return ++this.state.applyingUpdateGeneration;
  };

  private ownsApplyingUpdate = (generation: number): boolean =>
    generation === this.state.applyingUpdateGeneration &&
    this.state.shared.applyingUpdate;

  private finishApplyingUpdate = (generation: number): boolean => {
    if (!this.ownsApplyingUpdate(generation)) {
      return false;
    }
    this.clearReloadWatchdog();
    this.state.shared.applyingUpdate = false;
    return true;
  };

  private invalidateApplyingUpdate = () => {
    this.state.applyingUpdateGeneration++;
    this.clearReloadWatchdog();
    this.state.shared.applyingUpdate = false;
  };

  private armReloadWatchdog = (generation: number, onTimeout: () => void) => {
    if (!this.ownsApplyingUpdate(generation)) {
      return;
    }
    this.clearReloadWatchdog();
    const timer = setTimeout(() => {
      // A cancelled callback may already be queued; both identities must match.
      if (
        this.state.reloadWatchdogTimer !== timer ||
        !this.ownsApplyingUpdate(generation)
      ) {
        return;
      }
      this.state.reloadWatchdogTimer = undefined;
      this.state.shared.applyingUpdate = false;
      onTimeout();
    }, RELOAD_WATCHDOG_MS);
    this.state.reloadWatchdogTimer = timer;
  };

  private assertHash = (hash: string) => {
    const { downloadedHash } = this.state.shared;
    if (!downloadedHash) {
      log(`no downloaded hash yet, ignore switch to ${hash}`);
      return;
    }
    if (hash !== downloadedHash) {
      log(`use downloaded hash ${downloadedHash} first`);
      return;
    }
    return true;
  };

  runBeforeReload = async (context: BeforeReloadContext) => {
    const { beforeReload } = this.host.options;
    if (!beforeReload) {
      return true;
    }
    const shouldReload = await beforeReload(context);
    if (shouldReload === false) {
      log('beforeReload returned false, skipping reload');
      return false;
    }
    return true;
  };

  markSuccess = async () => {
    if (this.state.shared.marked || __DEV__ || !isFirstTime) {
      return;
    }
    // Concurrent callers (auto mark + an explicit call) would all pass the
    // check above before the first native call settles: share it.
    if (!this.state.markingPromise) {
      const promise = this.performMarkSuccess().finally(() => {
        if (this.state.markingPromise === promise) {
          this.state.markingPromise = undefined;
        }
      });
      this.state.markingPromise = promise;
    }
    return this.state.markingPromise;
  };

  private performMarkSuccess = async () => {
    try {
      await Promise.resolve(PushyModule.markSuccess());
    } catch (e) {
      throw this.reporter.fail(e, 'MARK_SUCCESS_FAILED', 'errorMarkSuccess');
    }
    this.state.shared.marked = true;
    this.host.report({ type: 'markSuccess' });
    // 救砖回执:这个版本是被救援通道送进来的,且活过了健康确认——遥测里
    // 一条 rescue 回执就是"这台设备被捞回来了"的证据。
    if (currentVersionInfo.forceBootRescue) {
      this.host.report({ type: 'forceBootRescue' });
    }
    if (currentVersionInfo.crashRescue) {
      this.host.report({ type: 'crashRescue' });
    }
  };

  /** The downloaded version switchVersion(Later) accepts; undefined before a download. */
  getDownloadedHash = (): string | undefined =>
    this.state.shared.downloadedHash;

  /**
   * Reload into a downloaded version. Resolves true once the native reload
   * was requested, false when the call was ignored (not the downloaded hash,
   * a switch already in progress, beforeReload declined, dev without debug).
   */
  switchVersion = async (hash: string): Promise<boolean> => {
    const { host } = this;
    if (!host.assertDebug('switchVersion()')) {
      return false;
    }
    if (!this.assertHash(hash)) {
      return false;
    }
    if (this.state.shared.applyingUpdate) {
      log(`switchVersion: ${hash} ignored, a switch is already in progress`);
      return false;
    }
    log(`switchVersion: ${hash}`);
    const applyingGeneration = this.beginApplyingUpdate();
    try {
      if (!(await this.host.runBeforeReload({ type: 'switchVersion', hash }))) {
        this.finishApplyingUpdate(applyingGeneration);
        return false;
      }
    } catch (e) {
      // Release before emitting: an onError listener may retry right away.
      this.finishApplyingUpdate(applyingGeneration);
      // A throw from the user's beforeReload hook is business-code failure,
      // not an update-pipeline one: give it a distinct code so telemetry
      // excludes it from the server-side patch-health stats.
      throw this.reporter.fail(e, 'USER_HOOK_ERROR', 'errorSwitchVersion', {
        data: { newVersion: hash },
      });
    }
    // resetToPackagedBundle may have completed while beforeReload awaited.
    if (!this.ownsApplyingUpdate(applyingGeneration)) {
      return false;
    }
    try {
      await PushyModule.reloadUpdate({ hash });
    } catch (e) {
      // Do not let a superseded rejection clear a newer switch.
      this.finishApplyingUpdate(applyingGeneration);
      throw this.reporter.fail(
        e,
        'SWITCH_VERSION_FAILED',
        'errorSwitchVersion',
        {
          data: { newVersion: hash },
        }
      );
    }
    // A resolved reloadUpdate normally tears this JS context down right away.
    // iOS has been seen resolving without restarting (89c638e); a stuck
    // applyingUpdate would then silently swallow every later switchVersion,
    // so release it once the process has outlived the reload and tell the
    // logger (RESTART_FAILED: restart mechanics, not patch health).
    this.armReloadWatchdog(applyingGeneration, () => {
      host.report({
        type: 'errorSwitchVersion',
        code: 'RESTART_FAILED',
        message: 'reloadUpdate resolved but the app did not restart',
        data: { newVersion: hash },
      });
    });
    return true;
  };

  switchVersionLater = async (hash: string) => {
    if (!this.host.assertDebug('switchVersionLater()')) {
      return;
    }
    if (this.assertHash(hash)) {
      log(`switchVersionLater: ${hash}`);
      try {
        return await PushyModule.setNeedUpdate({ hash });
      } catch (e) {
        throw this.reporter.fail(
          e,
          'SWITCH_VERSION_FAILED',
          'errorSwitchVersion',
          {
            data: { newVersion: hash },
          }
        );
      }
    }
  };

  restartApp = async () => {
    try {
      if (!(await this.host.runBeforeReload({ type: 'restartApp' }))) {
        return;
      }
    } catch (e) {
      throw this.reporter.fail(e, 'USER_HOOK_ERROR', 'errorRestart');
    }
    try {
      return await PushyModule.restartApp();
    } catch (e) {
      throw this.reporter.fail(e, 'RESTART_FAILED', 'errorRestart');
    }
  };

  /**
   * Reset to the bundle packaged in the binary: wipes the whole update state
   * on the native side, so the app loads the built-in bundle on the next
   * launch (or immediately with `{ restart: true }`), and deletes the
   * downloaded updates in the background (best-effort; the promise does not
   * wait for it). The client uuid is preserved.
   *
   * Returns whether the reset actually happened. Like the other update-flow
   * APIs it never throws by default — failures land in lastError/onError with
   * code RESET_FAILED — but the boolean must not be ignored: a false means the
   * app is still running the hot-updated bundle. Set `throwError` to throw.
   */
  resetToPackagedBundle = async (options?: {
    restart?: boolean;
  }): Promise<boolean> => {
    const { host } = this;
    if (!assertWeb()) {
      return false;
    }
    const reset = nativeMethod('resetToPackagedBundle');
    if (!reset) {
      const err = new UpdateError(
        host.t('error_reset_not_supported'),
        'RESET_FAILED'
      );
      this.reporter.emitError(err, 'errorReset');
      host.throwIfEnabled(err);
      return false;
    }
    try {
      await reset();
    } catch (e) {
      host.throwIfEnabled(this.reporter.fail(e, 'RESET_FAILED', 'errorReset'));
      return false;
    }
    // The downloaded versions are gone; drop JS bookkeeping referring to them
    // so a stale downloadedHash cannot be switched to.
    this.state.shared.downloadedHash = undefined;
    this.state.shared.toHash = undefined;
    this.state.shared.marked = false;
    // Invalidate the private owner too: old promises/timers must not touch
    // a switch that starts after this reset.
    this.invalidateApplyingUpdate();
    this.state.shared.apkStatus = null;
    host.report({ type: 'reset' });
    if (options?.restart) {
      try {
        await this.host.restartApp();
      } catch (e: any) {
        // The reset itself succeeded and the restart failure was already
        // reported through the pipeline; the boolean must still say "state
        // is reset".
        log('restart after reset failed:', e?.message || e);
      }
    }
    return true;
  };
}
