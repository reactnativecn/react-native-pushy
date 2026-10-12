package cn.reactnative.modules.update;

/** Built by the native applyArchiveDelta: one copy source and its targets. */
class CopyGroupResult {
    String from;
    String[] toPaths;
    // CRC32 the source content must match (__diff.json copiesCrc), or -1.
    long expectedCrc = -1;
}
