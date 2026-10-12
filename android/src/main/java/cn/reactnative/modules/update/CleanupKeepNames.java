package cn.reactnative.modules.update;

import java.util.LinkedHashSet;

/**
 * The distinct version names cleanup must never touch: the persisted current
 * and last versions AND the version this process booted from (two switches
 * without a restart otherwise evict the running bundle while its on-demand
 * assets are still being served).
 */
final class CleanupKeepNames {
    private CleanupKeepNames() {
    }

    static String[] select(String current, String previous, String running) {
        LinkedHashSet<String> keep = new LinkedHashSet<>();
        for (String candidate : new String[] {current, previous, running}) {
            if (candidate != null && !candidate.isEmpty()) {
                keep.add(candidate);
            }
        }
        return keep.toArray(new String[0]);
    }
}
