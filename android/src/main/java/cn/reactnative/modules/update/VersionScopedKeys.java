package cn.reactnative.modules.update;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * The keys of the main state file that describe installed versions rather
 * than the install itself: per-version info (hash_*), the first-load marker,
 * the native round's incomplete breadcrumb and the response cache's legacy
 * location. A binary upgrade or a reset to the packaged bundle drops exactly
 * these (plus the state fields applyState rewrites). Everything else — the
 * client uuid that buckets gray releases, the persisted native config the
 * cold-start round and crash hold run from, the bundle hash cache keyed by
 * package version — belongs to the install and survives, as on iOS and
 * Harmony.
 */
final class VersionScopedKeys {
    static final String HASH_INFO_PREFIX = "hash_";

    private VersionScopedKeys() {
    }

    static List<String> select(Collection<String> keys) {
        List<String> doomed = new ArrayList<>();
        for (String key : keys) {
            if (key == null) {
                continue;
            }
            if (key.startsWith(HASH_INFO_PREFIX)
                || key.equals(UpdateContext.KEY_FIRST_LOAD_MARKED)
                || key.equals(SyncCoordinator.KEY_ROUND_INCOMPLETE)
                || key.equals(SyncCoordinator.KEY_RESP_CACHE)) {
                doomed.add(key);
            }
        }
        return doomed;
    }
}
