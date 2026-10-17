// The single source of the values every platform must agree on. Edit here,
// then run `bun scripts/generate-contract.ts`: it rewrites each
// `<generated:NAME>` … `</generated:NAME>` region in the C++ headers, the
// Java and ArkTS mirrors, the JS layer and the build files. `bun lint` runs
// it with --check, so a region edited by hand (or a value changed here
// without regenerating) fails CI.
//
// The binding tables are generated from the declarations on the calling side
// instead: the Harmony method table and the old-architecture spec from
// src/NativePushy.ts, the JNI registration table and prototypes from the
// Java `native` declarations, the NAPI exports from NativePatchCore.ts. This
// file only adds what those declarations cannot say (which C++ function
// implements each one).

export interface ErrorCode {
  /** C++ name without the k prefix; Java/ArkTS use its SCREAMING_SNAKE. */
  name: string;
  value: string;
  doc: string;
  /** Stored encoded in native code (the value has update wording). */
  encoded?: boolean;
}

// cpp/patch_core/error_codes.h. Stable rejection codes of the native modules:
// the JS layer and user loggers aggregate on them; messages are free-form.
export const errorCodes: ErrorCode[] = [
  {
    name: 'InvalidOptions',
    value: 'INVALID_OPTIONS',
    doc: 'Method options missing or malformed (blank hash/url, wrong types).',
  },
  {
    name: 'DownloadFailed',
    value: 'DOWNLOAD_FAILED',
    doc: 'Native download failed (network error, bad HTTP status, truncated body).',
  },
  {
    name: 'DeltaFailed',
    value: 'PATCH_FAILED',
    encoded: true,
    doc: 'Unzip or hdiff patch application failed.',
  },
  {
    name: 'FileOperationFailed',
    value: 'FILE_OPERATION_FAILED',
    doc: 'Local file or state persistence operation failed.',
  },
  {
    name: 'SwitchVersionFailed',
    value: 'SWITCH_VERSION_FAILED',
    doc: 'switchVersion / setNeedUpdate state transition failed.',
  },
  {
    name: 'MarkSuccessFailed',
    value: 'MARK_SUCCESS_FAILED',
    doc: 'markSuccess state transition failed.',
  },
  {
    name: 'RestartFailed',
    value: 'RESTART_FAILED',
    doc: 'reloadUpdate / restartApp failed.',
  },
  {
    name: 'ResetFailed',
    value: 'RESET_FAILED',
    doc:
      'resetToPackagedBundle could not persist the reset state, or the installed ' +
      'native module predates the method (JS-layer detection). Deleting the ' +
      'downloaded versions afterwards is best-effort on every platform and never ' +
      'reports this code: the reset is complete once the state is.',
  },
  {
    name: 'InvalidHashInfo',
    value: 'INVALID_HASH_INFO',
    doc: 'Stored or provided hash info is not a valid JSON object.',
  },
  {
    name: 'UnsupportedPlatform',
    value: 'UNSUPPORTED_PLATFORM',
    doc:
      'The method is not supported on this platform (e.g. downloadAndInstallApk ' +
      'outside Android).',
  },
  {
    name: 'ApkInstallPermissionRequired',
    value: 'APK_INSTALL_PERMISSION_REQUIRED',
    doc:
      'Android full-package installation requires the user to trust the app as an ' +
      'install source before PackageInstaller can accept a session.',
  },
  {
    name: 'ApkInstallFailed',
    value: 'APK_INSTALL_FAILED',
    doc: 'PackageInstaller could not create, write, commit, or continue an APK session.',
  },
];

export type Host = 'java' | 'arkts';

export interface Limit {
  name: string;
  /** Factors multiplied together (kept readable: 512 * 1024 * 1024). */
  value: number[];
  doc?: string;
  /** Hosts that still compare against the value themselves. */
  hosts?: Host[];
}

// cpp/patch_core/archive_limits.h: damage bounds for a corrupt or hostile
// package. The accounting lives in archive_limits.cpp; hosts mirror only the
// caps they compare against on their own.
export const archiveLimits: Limit[] = [
  {
    name: 'MaxArchiveBytes',
    value: [512, 1024, 1024],
    doc: 'Downloaded archive (Content-Length up front, streamed bytes as backstop).',
    hosts: ['java', 'arkts'],
  },
  {
    name: 'MaxTotalUncompressedBytes',
    value: [2048, 1024, 1024],
    doc: "Sum of every entry's uncompressed size.",
    hosts: ['java'],
  },
  {
    name: 'MaxEntryBytes',
    value: [512, 1024, 1024],
    doc: "A single entry's uncompressed size.",
    hosts: ['java'],
  },
  {
    name: 'MaxEntries',
    value: [20000],
    doc: 'Number of entries in one archive.',
  },
  {
    name: 'MaxCompressionRatio',
    value: [100],
    doc:
      'Uncompressed/compressed ratio, of each entry and of the archive as a whole,\n' +
      'checked only above kRatioCheckMinBytes of expansion (tiny highly\n' +
      'compressible files are legitimate).',
  },
  { name: 'RatioCheckMinBytes', value: [1, 1024, 1024] },
  {
    name: 'MaxManifestBytes',
    value: [16, 1024, 1024],
    doc: '__diff.json is parsed fully in memory.',
    hosts: ['java', 'arkts'],
  },
  {
    name: 'FreeDiskMarginBytes',
    value: [64, 1024, 1024],
    doc: 'Free disk required beyond the bytes about to be written.',
    hosts: ['java', 'arkts'],
  },
  {
    name: 'UnknownLengthFreeSpaceProbeBytes',
    value: [8, 1024, 1024],
    doc:
      'A download whose length is unknown up front (chunked / encoded body) can\n' +
      'only reserve the margin when the response arrives; the disk is re-probed\n' +
      'before any write that would run past the bytes reserved so far, each\n' +
      'probe reserving at least this many bytes ahead (a single larger chunk\n' +
      'reserves its own size), so no write can ever eat into the margin.',
  },
];

// cpp/patch_core/install_record.h. The hosts build their unpack directory
// from the staging suffix.
export const installRecord = {
  schema: 1,
  fileName: '.pushy-complete',
  reservedPrefix: '.pushy-',
  stagingSuffix: '.staging',
  maxRecordBytes: [64, 1024],
};

// cpp/update_flow_core/native_round.h kMaxQueryRequests: HTTP requests one
// query may issue (endpoint queries and remote list fetches alike). The JS
// check's endpoint fallback keeps the same budget (src/endpoint.ts).
export const maxQueryRequests = 8;

// cpp/patch_core/state_ops.h. Android has no caller of ClearFirstTime.
export const stateOperations: { name: string; value: number; hosts: Host[] }[] = [
  { name: 'SwitchVersion', value: 1, hosts: ['java', 'arkts'] },
  { name: 'MarkSuccess', value: 2, hosts: ['java', 'arkts'] },
  { name: 'Rollback', value: 3, hosts: ['java', 'arkts'] },
  { name: 'ClearFirstTime', value: 4, hosts: [] },
  { name: 'ClearRollbackMark', value: 5, hosts: ['java', 'arkts'] },
  { name: 'ResolveLaunch', value: 6, hosts: ['java', 'arkts'] },
];

// cpp/patch_core/archive_patch_core.h ArchivePatchType; also the hosts' task
// types and the iOS PushyType, which cross the boundary as these numbers
// (each side keeps its historical name: the package is the APK / the app).
export const archivePatchTypes = [
  { name: 'Full', value: 1, java: 'FULL', arkts: 'FULL', objc: 'FullDownload' },
  {
    name: 'PatchFromPackage',
    value: 2,
    java: 'FROM_APK',
    arkts: 'FROM_APP',
    objc: 'PatchFromPackage',
  },
  {
    name: 'PatchFromPpk',
    value: 3,
    java: 'FROM_PPK',
    arkts: 'FROM_PPK',
    objc: 'PatchFromPpk',
  },
];

// The host-facing result of a native round (prepareBundle).
export const roundStatuses = [
  { name: 'Skipped', value: 'skipped' },
  { name: 'NoUpdate', value: 'noUpdate' },
  { name: 'Downloaded', value: 'downloaded' },
  { name: 'Failed', value: 'failed' },
  { name: 'Cancelled', value: 'cancelled' },
];

// Every Android ABI the prebuilt library ships for.
export const androidAbis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];

// The vendored HDiffPatch / lzma decoder sources hpatch.c needs, compiled by
// every platform build (the shared cores themselves are globbed by directory).
export const vendoredSources = [
  'android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c',
  'android/jni/HDiffPatch/file_for_patch.c',
  'android/jni/lzma/C/LzmaDec.c',
  'android/jni/lzma/C/Lzma2Dec.c',
];

// Java `native` method -> the C++ function in cpp/android_jni that implements
// it. The descriptor and the prototype come from the Java declaration.
export const jniFunctions: Record<string, string> = {
  'NativeCore.getSupportedDiffVersion': 'SupportedDiffVersion',
  'UpdateContext.syncStateWithBinaryVersion': 'SyncStateWithBinaryVersion',
  'UpdateContext.runStateCore': 'RunStateCore',
  'DownloadTask.applyArchiveDelta': 'ApplyArchiveDelta',
  'DownloadTask.cleanupOldEntries': 'CleanupOldEntries',
  'FlowBridge.prepareRound': 'FlowPrepareRound',
  'FlowBridge.nextQueryStep': 'FlowNextQueryStep',
  'FlowBridge.stepRound': 'FlowStepRound',
  'FlowBridge.handleResponse': 'FlowHandleResponse',
  'FlowBridge.configsEquivalent': 'FlowConfigsEquivalent',
  'FlowBridge.runnableConfig': 'FlowRunnableConfig',
  'FlowBridge.normalizeConfiguration': 'FlowNormalizeConfiguration',
  'InstallRecord.isComplete': 'InstallRecordIsComplete',
  'InstallRecord.checkActivation': 'InstallRecordCheckActivation',
  'InstallRecord.sealStaging': 'InstallRecordSeal',
  'InstallRecord.promoteStaging': 'InstallRecordPromote',
  'InstallRecord.bundleSha256Of': 'InstallRecordBundleSha256',
  'ArchiveLimits.checkEntries': 'ArchiveCheckEntries',
  'ArchiveLimits.planFreeSpaceProbe': 'ArchivePlanFreeSpaceProbe',
  'ResumePlan.planRequest': 'ResumePlanRequest',
  'ResumePlan.classifyResponse': 'ResumeClassifyResponse',
  'ResumePlan.sidecar': 'ResumeSidecar',
  'StoreMigration.migrateStoredItems': 'StoredItemsMigrate',
};

// NativePatchCore.ts binding -> the NAPI callback in pushy.cpp.
export const napiFunctions: Record<string, string> = {
  syncStateWithBinaryVersion: 'SyncStateWithBinaryVersion',
  runStateCore: 'RunStateCore',
  applyArchiveDelta: 'ApplyArchiveDelta',
  cleanupOldEntries: 'CleanupOldEntries',
  sha256HexFileAsync: 'Sha256HexFileAsync',
  sha256HexRawFdAsync: 'Sha256HexRawFdAsync',
  isInstallComplete: 'InstallRecordIsComplete',
  recordedBundleSha256: 'InstallRecordBundleSha256',
  sealInstallRecord: 'SealInstallRecord',
  promoteStaging: 'PromoteStaging',
  checkActivation: 'CheckActivation',
  checkUncompressedSize: 'CheckUncompressedSize',
  planFreeSpaceProbe: 'PlanFreeSpaceProbe',
  checkExtractedDirectory: 'CheckExtractedDirectory',
  crc32: 'Crc32',
  getSupportedDiffVersion: 'GetSupportedDiffVersion',
  prepareRound: 'FlowPrepareRound',
  nextQueryStep: 'FlowNextQueryStep',
  stepRound: 'FlowStepRound',
  handleResponse: 'FlowHandleResponse',
  configsEquivalent: 'FlowConfigsEquivalent',
  runnableConfig: 'FlowRunnableConfig',
  normalizeConfiguration: 'FlowNormalizeConfiguration',
  resumePlanRequest: 'ResumePlanRequest',
  resumeClassifyResponse: 'ResumeClassifyResponse',
  resumeSidecar: 'ResumeSidecar',
  migrateStoredItems: 'MigrateStoredItems',
};

export type TextHost = 'cpp' | 'java' | 'arkts';

export interface NativeText {
  /** C++ function name; Java/ArkTS use its SCREAMING_SNAKE. */
  name: string;
  value: string;
  /** cpp covers the shared cores and iOS (cpp/patch_core/native_texts.h). */
  hosts: TextHost[];
  /** Per-host values where a platform names the same thing differently. */
  values?: Partial<Record<TextHost, string>>;
  doc?: string;
}

// Plain text with update wording (or a service address) that shipped native
// code needs: stored encoded (scripts/encode-native-text.ts) so it never
// appears in the binaries' string tables, and decoded on first use.
export const nativeTexts: NativeText[] = [
  {
    name: 'StatusNone',
    value: 'noUpdate',
    hosts: ['cpp', 'arkts'],
    doc: 'The round status / decision reason when nothing is to be installed.',
  },
  {
    name: 'InfoCrashHold',
    value: 'crashRescue',
    hosts: ['cpp', 'java'],
    doc: 'Version-info flag of a version a crash hold installed (read by JS).',
  },
  {
    name: 'InfoForceBoot',
    value: 'forceBootRescue',
    hosts: ['cpp'],
    doc: 'Version-info flag of a version the server forceBoot-activated.',
  },
  { name: 'QueryPath', value: '/checkUpdate/', hosts: ['cpp'] },
  {
    name: 'PolicyNextLaunch',
    value: 'setNeedUpdate',
    hosts: ['cpp'],
    doc: 'The afterDownload policy that activates for the next launch.',
  },
  { name: 'FieldAvailable', value: 'update', hosts: ['cpp'] },
  { name: 'PreferencesName', value: 'update', hosts: ['java', 'arkts'] },
  { name: 'StorageDirName', value: '_update', hosts: ['java', 'arkts'] },
  {
    name: 'BundleDeltaEntry',
    value: 'index.bundlejs.patch',
    hosts: ['cpp', 'java', 'arkts'],
    values: { arkts: 'bundle.harmony.js.patch' },
    doc: 'The bundle patch entry inside a patch archive.',
  },
  { name: 'OptionUrlKey', value: 'updateUrl', hosts: ['cpp', 'java'] },
  { name: 'PpkDeltaSuffix', value: '.ppk.patch', hosts: ['cpp', 'java', 'arkts'] },
  {
    name: 'PackageDeltaSuffix',
    value: '.ipa.patch',
    hosts: ['cpp', 'java', 'arkts'],
    values: { java: '.apk.patch', arkts: '.app.patch' },
    doc: 'Archive suffix of a patch against the installed package.',
  },
  { name: 'LogTag', value: 'react-native-update', hosts: ['cpp', 'java'] },
  { name: 'LibraryName', value: 'rnpushy', hosts: ['java'] },
  {
    name: 'InstallerSessionExtra',
    value: 'cn.reactnative.modules.update.extra.PACKAGE_INSTALLER_SESSION_ID',
    hosts: ['java'],
  },
  { name: 'ReloadMethod', value: 'reload', hosts: ['java'] },
  { name: 'DevtoolsRestartEvent', value: 'RELOAD', hosts: ['arkts'] },
  { name: 'DevtoolsRestartReason', value: 'HotReload2', hosts: ['arkts'] },
  {
    name: 'StateResultClass',
    value: 'cn/reactnative/modules/update/StateCoreResult',
    hosts: ['cpp'],
  },
  {
    name: 'CopyGroupResultClass',
    value: 'cn/reactnative/modules/update/CopyGroupResult',
    hosts: ['cpp'],
  },
];

// Default service addresses: the JS client's presets, and Pushy's (the only
// brand native configure() defaults to) encoded for native code.
export const servicePresets = {
  Pushy: {
    main: ['https://update.react-native.cn/api', 'https://update.reactnative.cn/api'],
    queryUrls: [
      'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
    ],
  },
  Cresc: {
    main: ['https://api.cresc.dev', 'https://api.cresc.app'],
    queryUrls: [
      'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints_cresc.json',
    ],
  },
};


// --- Persisted layout (schema 1) --------------------------------------------
//
// Every platform keeps the same keys, with the same value encoding, in two
// key-value stores of its own (Android SharedPreferences files, iOS
// NSUserDefaults suites, Harmony preferences). The generator turns this into
// each platform's key table and its State <-> store mapping; the one-time
// move out of the layouts SDKs up to 10.61 wrote is the shared
// cpp/patch_core/stored_items.h (vectors: stored-items-vectors.json).
//
// Every value is a string. A boolean is "1" or "0"; a marker is "1" while set
// and absent otherwise; an empty string is never stored (writing one removes
// the key), so absent and empty read the same.

export type Platform = 'android' | 'ios' | 'harmony';

export const storeSchema = {
  version: 1,
  versionKey: 'schemaVersion',
  /** The main store: the state fields and every item without `store`. */
  stateStore: 'pushy_state',
  /**
   * Whole server responses: kept apart so the small state commits do not
   * rewrite them (every platform rewrites a store's whole file).
   */
  cacheStore: 'pushy_cache',
  booleans: { true: '1', false: '0' },
};

export interface StateField {
  /** The key, and the field's name in Java/ArkTS (C++ uses its snake_case). */
  name: string;
  type: 'string' | 'boolean';
  /** What an absent boolean reads as. */
  fallback?: boolean;
}

// pushy::state::State (cpp/patch_core/state_core.h), which the shared state
// core rewrites as a whole.
export const stateFields: StateField[] = [
  { name: 'packageVersion', type: 'string' },
  { name: 'buildTime', type: 'string' },
  { name: 'currentVersion', type: 'string' },
  { name: 'lastVersion', type: 'string' },
  { name: 'firstTime', type: 'boolean', fallback: false },
  { name: 'firstTimeOk', type: 'boolean', fallback: true },
  { name: 'rolledBackVersion', type: 'string' },
];

export type Lifecycle = 'reset' | 'binaryUpgrade';

export interface StoredItem {
  name: string;
  doc: string;
  key: string;
  /** The key is a prefix (one entry per version). */
  prefix?: boolean;
  /** Kept in the cache store instead of the state store. */
  cache?: boolean;
  /** A flag: "1" while set, absent otherwise (any legacy value counts as set). */
  marker?: boolean;
  /** The events that delete it; everything else survives both. */
  clearedOn: Lifecycle[];
  /** The platforms that use it (all when absent). */
  platforms?: Platform[];
}

// The persisted items next to the state fields and what a reset to the
// packaged bundle or a binary upgrade does to them, the same on every
// platform.
export const storedItems: StoredItem[] = [
  {
    name: 'HashInfo',
    key: 'hash_',
    prefix: true,
    doc: 'Per-version info: name, description, metaInfo and the rescue flags.',
    clearedOn: ['reset', 'binaryUpgrade'],
  },
  {
    name: 'FirstLoadMarker',
    key: 'firstLoadMarked',
    marker: true,
    doc: 'Set when a launch consumes first_time; getConstants reports and clears it.',
    clearedOn: ['reset', 'binaryUpgrade'],
  },
  {
    name: 'BinaryUpgradedMarker',
    key: 'binaryUpgraded',
    marker: true,
    doc: 'Set by a binary upgrade, consumed by getConstants (old version cleanup).',
    clearedOn: ['reset'],
    platforms: ['ios'],
  },
  {
    name: 'CheckCache',
    key: 'nativeCheckResp',
    cache: true,
    doc:
      "The native round's raw response for the JS side to reuse (§10.3), scoped\n" +
      'to the exact logical request and native config that produced it. It\n' +
      'describes versions a reset or an upgrade removes.',
    clearedOn: ['reset', 'binaryUpgrade'],
  },
  {
    name: 'RoundBreadcrumb',
    key: 'nativeCheckIncomplete',
    marker: true,
    doc:
      'Set when a round starts, cleared when it ends (§11.4). Residue on the\n' +
      'next launch means the previous process died mid-round: that launch\n' +
      'resumes immediately instead of waiting 5s.',
    clearedOn: [],
  },
  {
    name: 'Uuid',
    key: 'uuid',
    doc: 'Identifies the install for gray-release bucketing: must never change.',
    clearedOn: [],
  },
  {
    name: 'NativeConfig',
    key: 'nativeConfig',
    doc:
      'The persisted native check config (JS syncNativeConfig or the host) the\n' +
      'cold-start round and the crash hold run from.',
    clearedOn: [],
  },
  {
    name: 'BundleHashCache',
    key: 'bundleHashCache',
    doc:
      '"<binary identity>|<sha256>" of the embedded bundle: keyed by the binary,\n' +
      'so it invalidates itself on upgrade.',
    clearedOn: [],
  },
];

export interface LegacyLayout {
  platform: Platform;
  /** Crosses JNI/NAPI as this number. */
  id: number;
  doc: string;
  /**
   * What the migration carries over: new key <- legacy key. Only what a
   * binary upgrade keeps (the uuid, the native config, the breadcrumb, the
   * bundle hash cache) and the binary identity that upgrade is detected
   * from: the new layout only ships in a new binary, whose first launch
   * resets every other state field anyway (SyncBinaryVersion).
   */
  carried: Record<string, string>;
  /** Legacy keys deleted without carrying them, every one an SDK ever wrote. */
  dropped: string[];
  droppedPrefixes: string[];
}

const androidLegacy = {
  carried: {
    uuid: 'uuid',
    nativeConfig: 'nativeConfig',
    nativeCheckIncomplete: 'nativeCheckIncomplete',
    bundleHashCache: 'bundleHashCache',
    packageVersion: 'packageVersion',
    buildTime: 'buildTime',
  },
  dropped: [
    'currentVersion',
    'lastVersion',
    'firstTime',
    'firstTimeOk',
    'rolledBackVersion',
    'firstLoadMarked',
    'nativeCheckResp',
    'rolledBack',
    'shouldRollback',
    'blockUntil',
    'blockReason',
  ],
  droppedPrefixes: ['hash_'],
};

// The layouts SDKs up to 10.61 wrote.
export const legacyLayouts: LegacyLayout[] = [
  {
    platform: 'android',
    id: 1,
    doc:
      'SharedPreferences Texts.PREFERENCES_NAME, and its "_check" file for the\n' +
      'response cache; native booleans.',
    ...androidLegacy,
  },
  {
    platform: 'ios',
    id: 2,
    doc:
      'standardUserDefaults, shared with the host app: only these keys are\n' +
      "ours (the unprefixed packageVersion/buildTime that SDKs before 10.5x\n" +
      'wrote are left alone, they may be the host\'s).',
    carried: {
      uuid: 'REACTNATIVECN_PUSHY_UUID',
      nativeConfig: 'REACTNATIVECN_PUSHY_NATIVE_CONFIG_KEY',
      nativeCheckIncomplete: 'REACTNATIVECN_PUSHY_NATIVE_CHECK_INCOMPLETE_KEY',
      bundleHashCache: 'REACTNATIVECN_PUSHY_BUNDLEHASH_KEY',
      packageVersion: 'REACTNATIVECN_PUSHY_PACKAGEVERSION',
      buildTime: 'REACTNATIVECN_PUSHY_BUILDTIME',
    },
    dropped: [
      'REACTNATIVECN_PUSHY_INFO_KEY',
      'REACTNATIVECN_PUSHY_FIRSTLOADMARKED_KEY',
      'REACTNATIVECN_PUSHY_ROLLEDBACKMARKED_KEY',
      'REACTNATIVECN_PUSHY_ISPACKAGEUPDATEDMARKED_KEY',
      'REACTNATIVECN_PUSHY_NATIVE_CHECK_RESP_KEY',
      'REACTNATIVECN_PUSHY_BLOCKUPDATE',
      'REACTNATIVECN_PUSHY_BUNDLEHASH_IDENTITY',
      'REACTNATIVECN_PUSHY_BUNDLEHASH_VALUE',
    ],
    droppedPrefixes: ['REACTNATIVECN_PUSHY_HASH_'],
  },
  {
    platform: 'harmony',
    id: 3,
    doc: 'preferences Texts.PREFERENCES_NAME; booleans native or "true".',
    ...androidLegacy,
  },
];

