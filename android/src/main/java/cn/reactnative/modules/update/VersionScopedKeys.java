package cn.reactnative.modules.update;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * The keys of the main state file that describe installed versions rather
 * than the install itself. What a binary upgrade or a reset to the packaged
 * bundle drops (besides the state fields applyState rewrites) is the same on
 * every platform and generated from scripts/contract.ts (storedItems); the
 * install's own keys — the client uuid that buckets gray releases, the
 * persisted native config the cold-start round and crash hold run from, the
 * round breadcrumb, the bundle hash cache keyed by package version — survive.
 */
final class VersionScopedKeys {
    // <generated:lifecycle> (scripts/contract.ts; bun scripts/generate-contract.ts)
    // What a reset to the packaged bundle and a binary upgrade delete from the
    // state store besides the state fields (scripts/contract.ts storedItems;
    // the cache store is cleared on both, every other item survives both: the
    // uuid, the native config, the round breadcrumb, the bundle hash cache).
    static final String[] RESET_KEYS = {StoreSchema.KEY_FIRST_LOAD_MARKER};
    static final String[] RESET_PREFIXES = {StoreSchema.KEY_HASH_INFO};
    static final String[] UPGRADE_KEYS = {StoreSchema.KEY_FIRST_LOAD_MARKER};
    static final String[] UPGRADE_PREFIXES = {StoreSchema.KEY_HASH_INFO};
    // </generated:lifecycle>

    private VersionScopedKeys() {
    }

    /** The keys a reset to the packaged bundle deletes. */
    static List<String> clearedOnReset(Collection<String> keys) {
        return select(keys, RESET_KEYS, RESET_PREFIXES);
    }

    /** The keys a binary upgrade deletes. */
    static List<String> clearedOnUpgrade(Collection<String> keys) {
        return select(keys, UPGRADE_KEYS, UPGRADE_PREFIXES);
    }

    private static List<String> select(
        Collection<String> keys, String[] exact, String[] prefixes
    ) {
        List<String> doomed = new ArrayList<>();
        for (String key : keys) {
            if (key == null) {
                continue;
            }
            boolean match = false;
            for (String name : exact) {
                match |= key.equals(name);
            }
            for (String prefix : prefixes) {
                match |= key.startsWith(prefix);
            }
            if (match) {
                doomed.add(key);
            }
        }
        return doomed;
    }
}
