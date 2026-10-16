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
      'resetToPackagedBundle failed (state wipe or cleanup could not run), or the ' +
      'installed native module predates the method (JS-layer detection).',
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

// Storage keys the Android and Harmony orchestrators share (iOS uses its own
// REACTNATIVECN_PUSHY_* names).
export const syncStorageKeys = [
  {
    name: 'Config',
    value: 'nativeConfig',
    doc: 'The persisted native check config (JS syncNativeConfig or the host).',
  },
  {
    name: 'RespCache',
    value: 'nativeCheckResp',
    doc:
      'Raw response cache for the JS side to reuse (§10.3), scoped to the exact\n' +
      'logical request and native config that produced it.',
  },
  {
    name: 'RoundIncomplete',
    value: 'nativeCheckIncomplete',
    doc:
      'Set when a round starts, cleared when it ends (§11.4). Residue on the\n' +
      'next launch means the previous process died mid-round: that launch\n' +
      'resumes immediately instead of waiting 5s.',
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
  {
    name: 'PackageUpdatedMarkedKey',
    value: 'REACTNATIVECN_PUSHY_ISPACKAGEUPDATEDMARKED_KEY',
    hosts: ['cpp'],
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

export type Lifecycle = 'reset' | 'binaryUpgrade';

export interface StoredItem {
  name: string;
  doc: string;
  /** The key is a prefix (one entry per version). */
  prefix?: boolean;
  /** The events that delete it; everything else survives both. */
  clearedOn: Lifecycle[];
  /** The key (or prefix) as an expression in each platform's own code. */
  keys: { objc?: string; java?: string; arkts?: string };
}

// The persisted items next to the state fields (which the shared state core
// rewrites itself) and what a reset to the packaged bundle or a binary
// upgrade does to them, the same on every platform. The physical keys stay
// as each platform has always stored them (no format migration).
export const storedItems: StoredItem[] = [
  {
    name: 'HashInfo',
    prefix: true,
    doc: 'Per-version info: name, description, metaInfo and the rescue flags.',
    clearedOn: ['reset', 'binaryUpgrade'],
    keys: { objc: 'keyHashInfo', java: 'HASH_INFO_PREFIX', arkts: 'HASH_INFO_PREFIX' },
  },
  {
    name: 'FirstLoadMarker',
    doc: 'Set when a launch consumes first_time; getConstants reports and clears it.',
    clearedOn: ['reset', 'binaryUpgrade'],
    keys: {
      objc: 'keyFirstLoadMarked',
      java: 'UpdateContext.KEY_FIRST_LOAD_MARKED',
      arkts: 'FIRST_LOAD_MARKED_KEY',
    },
  },
  {
    name: 'PackageUpdatedMarker',
    doc: 'iOS: set by a binary upgrade, consumed by getConstants (old version cleanup).',
    clearedOn: ['reset'],
    keys: { objc: 'KeyPackageUpdatedMarked()' },
  },
  {
    name: 'CheckCache',
    doc:
      "The native round's response cache: it describes versions the event just\n" +
      'removed (Android: its legacy location here; its own file is cleared too).',
    clearedOn: ['reset', 'binaryUpgrade'],
    keys: {
      objc: 'keyNativeCheckCache',
      java: 'SyncCoordinator.KEY_RESP_CACHE',
      arkts: 'KEY_RESP_CACHE',
    },
  },
  {
    name: 'RoundBreadcrumb',
    doc: 'Only decides whether the next launch resumes the round without the 5s delay.',
    clearedOn: [],
    keys: {
      objc: 'keyNativeCheckIncomplete',
      java: 'SyncCoordinator.KEY_ROUND_INCOMPLETE',
      arkts: 'KEY_ROUND_INCOMPLETE',
    },
  },
  {
    name: 'Uuid',
    doc: 'Identifies the install for gray-release bucketing: must never change.',
    clearedOn: [],
    keys: {},
  },
  {
    name: 'NativeConfig',
    doc: 'The host or JS config the cold-start round and crash hold run from.',
    clearedOn: [],
    keys: {},
  },
  {
    name: 'BundleHashCache',
    doc: 'Keyed by the binary identity, so it invalidates itself on upgrade.',
    clearedOn: [],
    keys: {},
  },
];
