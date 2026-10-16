#!/usr/bin/env bun
// Rewrites every `<generated:NAME>` region from scripts/contract.ts and the
// calling-side declarations (see the header of contract.ts).
//   bun scripts/generate-contract.ts          rewrite the regions
//   bun scripts/generate-contract.ts --check  fail when any region is stale
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  androidAbis,
  archiveLimits,
  archivePatchTypes,
  errorCodes,
  type Host,
  installRecord,
  jniFunctions,
  maxQueryRequests,
  napiFunctions,
  roundStatuses,
  stateOperations,
  syncStorageKeys,
  vendoredSources,
} from './contract';
import { encodeNativeText } from './encode-native-text';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const javaDir = 'android/src/main/java/cn/reactnative/modules/update';
const javaPackage = 'cn/reactnative/modules/update/';
const ets = 'harmony/pushy/src/main/ets';

// kMaxArchiveBytes -> MAX_ARCHIVE_BYTES
const snake = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

// `//`-style comment lines, wrapped at 80 columns including `indent`.
const comment = (doc: string | undefined, indent = 0, prefix = '// ') => {
  if (!doc) {
    return [];
  }
  const width = 80 - indent - prefix.length;
  const lines: string[] = [];
  for (const paragraph of doc.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(prefix + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(prefix + line);
  }
  return lines;
};

// `<head> = <value>;`, the value moved to its own line past 80 columns.
const assign = (head: string, value: string, indent: number, continuation: number) => {
  const line = `${head} = ${value};`;
  return indent + line.length <= 80
    ? [line]
    : [`${head} =`, `${' '.repeat(continuation)}${value};`];
};

const product = (factors: number[], suffix: string) =>
  factors.length === 1
    ? String(factors[0])
    : [`${factors[0]}${suffix}`, ...factors.slice(1)].join(' * ');

const hostsOf = (hosts: Host[] | undefined, host: Host) =>
  (hosts ?? []).includes(host);

// --- Declarations on the calling side --------------------------------------

interface SpecMethod {
  name: string;
  params: { name: string; java: string }[];
  promise: boolean;
}

// src/NativePushy.ts: the codegen spec every native module implements.
// A small bracket-matching reader over `interface Spec`, enough for its
// shape: `getConstants: () => {...};` and `name(params): Return;` members.
function specMethods(): SpecMethod[] {
  const source = read('src/NativePushy.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const start = source.indexOf('interface Spec');
  if (start < 0) {
    throw new Error('src/NativePushy.ts: no Spec interface');
  }
  const open = source.indexOf('{', start);
  // The index just past the bracket that closes the one at `from`.
  const matching = (from: number) => {
    let depth = 0;
    for (let i = from; i < source.length; i++) {
      const c = source[i];
      if (c === '{' || c === '(' || c === '<') {
        depth++;
      } else if (c === '}' || c === ')' || (c === '>' && source[i - 1] !== '=')) {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
    }
    throw new Error('src/NativePushy.ts: unbalanced brackets');
  };
  const body = source.slice(open + 1, matching(open) - 1);
  // Splits on commas outside any bracket.
  const topLevel = (text: string) => {
    const parts: string[] = [];
    let depth = 0;
    let part = '';
    for (const c of text) {
      if (c === '{' || c === '(' || c === '<') depth++;
      if (c === '}' || c === ')' || c === '>') depth--;
      if (c === ',' && depth === 0) {
        parts.push(part);
        part = '';
      } else {
        part += c;
      }
    }
    parts.push(part);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  const javaType = (type: string, where: string) => {
    if (type === 'string') return 'String';
    if (type === 'number') return 'double';
    if (type === 'boolean') return 'boolean';
    if (type.startsWith('{')) return 'ReadableMap';
    throw new Error(`${where}: unsupported type ${type}`);
  };
  const methods: SpecMethod[] = [];
  const member = /^\s*(\w+)\s*(\(|:)/gm;
  let match: RegExpExecArray | null;
  while ((match = member.exec(body)) !== null) {
    const name = match[1];
    if (match[2] === ':') {
      if (name !== 'getConstants') {
        throw new Error(`src/NativePushy.ts: unexpected member ${name}`);
      }
      methods.push({ name, params: [], promise: false });
      const brace = body.indexOf('{', member.lastIndex);
      member.lastIndex = brace + bodyMatching(body, brace);
      continue;
    }
    const paramsStart = member.lastIndex - 1;
    const paramsEnd = paramsStart + bodyMatching(body, paramsStart);
    const params = topLevel(body.slice(paramsStart + 1, paramsEnd - 1)).map(
      (param) => {
        const colon = param.indexOf(':');
        const paramName = param.slice(0, colon).trim();
        return {
          name: paramName,
          java: javaType(param.slice(colon + 1).trim(), `${name}(${paramName})`),
        };
      }
    );
    const end = body.indexOf(';', paramsEnd);
    const returns = body.slice(body.indexOf(':', paramsEnd) + 1, end).trim();
    methods.push({ name, params, promise: returns.startsWith('Promise<') });
    member.lastIndex = end + 1;
  }
  return methods;
}

// Length from `from` (an opening bracket) to just past its closing bracket.
function bodyMatching(text: string, from: number) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(') {
      depth++;
    } else if (c === '}' || c === ')') {
      depth--;
      if (depth === 0) {
        return i + 1 - from;
      }
    }
  }
  throw new Error('src/NativePushy.ts: unbalanced brackets');
}

interface JavaNative {
  className: string;
  name: string;
  returns: string;
  params: { type: string; name: string }[];
}

// Every Java `native` declaration of the update package.
function javaNatives(): JavaNative[] {
  const natives: JavaNative[] = [];
  for (const file of readdirSync(join(root, javaDir)).sort()) {
    if (!file.endsWith('.java')) {
      continue;
    }
    const source = read(`${javaDir}/${file}`)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const match of source.matchAll(
      /\bnative\s+([\w[\]]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?;/g
    )) {
      natives.push({
        className: file.replace('.java', ''),
        name: match[2],
        returns: match[1],
        params: match[3]
          .split(',')
          .map((param) => param.trim())
          .filter(Boolean)
          .map((param) => {
            const [type, name] = param.split(/\s+/);
            return { type, name };
          }),
      });
    }
  }
  return natives;
}

// `interface NativePatchCoreBindings` method names, in declaration order.
function napiBindings(): string[] {
  const source = read(`${ets}/NativePatchCore.ts`);
  const start = source.indexOf('interface NativePatchCoreBindings');
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1]);
}

// --- Generated regions -----------------------------------------------------

type Regions = Record<string, Record<string, string[]>>;
const regions: Regions = {};
const region = (file: string, name: string, lines: string[]) => {
  regions[file] ??= {};
  regions[file][name] = lines;
};

// Error codes.
region(
  'cpp/patch_core/error_codes.h',
  'error-codes',
  errorCodes.flatMap(({ name, value, doc, encoded }) => [
    ...comment(doc),
    ...(encoded
      ? assign(
          `inline const char* const k${name}`,
          `text::RevealStatic("${encodeNativeText(value)}")`,
          0,
          4
        )
      : assign(`constexpr const char* k${name}`, `"${value}"`, 0, 4)),
  ])
);
region(
  `${javaDir}/ErrorCodes.java`,
  'error-codes',
  errorCodes.flatMap(({ name, value, encoded }) =>
    encoded
      ? [
          `// Encoded (see Texts.reveal): the value is "${value}".`,
          `static final String ${snake(name)} = Texts.reveal("${encodeNativeText(value)}");`,
        ]
      : [`static final String ${snake(name)} = "${value}";`]
  )
);
region(
  `${ets}/ErrorCodes.ts`,
  'error-codes',
  errorCodes.flatMap(({ name, value, encoded }) =>
    assign(
      `export const ERROR_${snake(name)}`,
      encoded ? `revealText('${encodeNativeText(value)}')` : `'${value}'`,
      0,
      2
    )
  )
);
region(
  'src/error.ts',
  'native-error-codes',
  errorCodes.map(({ value }) => `'${value}',`)
);

// Archive limits.
region(
  'cpp/patch_core/archive_limits.h',
  'limits',
  archiveLimits.flatMap(({ name, value, doc }) => [
    ...comment(doc),
    `constexpr long long k${name} = ${product(value, 'LL')};`,
  ])
);
region(
  `${javaDir}/ArchiveLimits.java`,
  'limits',
  archiveLimits
    .filter(({ hosts }) => hostsOf(hosts, 'java'))
    .map(({ name, value }) => `static final long ${snake(name)} = ${product(value, 'L')};`)
);
region(
  `${ets}/ArchiveLimits.ts`,
  'limits',
  archiveLimits
    .filter(({ hosts }) => hostsOf(hosts, 'arkts'))
    .map(({ name, value }) => `export const ${snake(name)} = ${product(value, '')};`)
);

// Install record.
region('cpp/patch_core/install_record.h', 'constants', [
  `constexpr int kSchema = ${installRecord.schema};`,
  `constexpr const char* kFileName = "${installRecord.fileName}";`,
  '// Every name starting with this prefix, at any depth of a version directory,',
  '// belongs to the SDK (the record, its temp file): no archive may ship one',
  '// (archive_limits::IsReservedEntryName).',
  `constexpr const char* kReservedPrefix = "${installRecord.reservedPrefix}";`,
  `constexpr const char* kStagingSuffix = "${installRecord.stagingSuffix}";`,
  '// A record is a few hundred bytes; anything larger is not one.',
  `constexpr long long kMaxRecordBytes = ${product(installRecord.maxRecordBytes, '')};`,
]);
region(`${javaDir}/InstallRecord.java`, 'staging-suffix', [
  `static final String STAGING_SUFFIX = "${installRecord.stagingSuffix}";`,
]);
region(`${ets}/InstallRecord.ts`, 'staging-suffix', [
  `export const STAGING_SUFFIX = '${installRecord.stagingSuffix}';`,
]);

// Query budget.
region('cpp/update_flow_core/native_round.h', 'query-budget', [
  `constexpr int kMaxQueryRequests = ${maxQueryRequests};`,
]);
region('src/endpoint.ts', 'query-budget', [
  `export const MAX_ENDPOINT_REQUESTS = ${maxQueryRequests};`,
]);

// State operations.
region(
  'cpp/patch_core/state_ops.h',
  'state-operations',
  stateOperations.map(({ name, value }) => `k${name} = ${value},`)
);
const stateOpHost = (host: Host, declare: (name: string, value: number) => string) =>
  stateOperations.map(({ name, value, hosts }) =>
    hosts.includes(host)
      ? declare(`STATE_OP_${snake(name)}`, value)
      : `// ${value} (${name}) has no caller on this side.`
  );
region(
  `${javaDir}/UpdateContext.java`,
  'state-operations',
  stateOpHost('java', (name, value) => `private static final int ${name} = ${value};`)
);
region(
  `${ets}/NativePatchCore.ts`,
  'state-operations',
  stateOpHost('arkts', (name, value) => `export const ${name} = ${value};`)
);

// Archive patch types.
region(
  'cpp/patch_core/archive_patch_core.h',
  'archive-patch-types',
  archivePatchTypes.map(({ name, value }) => `k${name} = ${value},`)
);
region(
  `${ets}/NativePatchCore.ts`,
  'archive-patch-types',
  archivePatchTypes.map(
    ({ name, value }) =>
      `export const ARCHIVE_PATCH_TYPE_${snake(name).replace(/^PATCH_/, '')} = ${value};`
  )
);
region(
  `${javaDir}/DownloadTaskParams.java`,
  'archive-patch-types',
  archivePatchTypes.map(
    ({ java, value }) => `static final int TASK_TYPE_PATCH_${java} = ${value};`
  )
);
region(
  `${ets}/DownloadTaskParams.ts`,
  'archive-patch-types',
  archivePatchTypes.map(
    ({ arkts, value }) =>
      `static readonly TASK_TYPE_PATCH_${arkts}: number = ${value};`
  )
);
region(
  'ios/RCTPushy/RCTPushyInternal.h',
  'archive-patch-types',
  archivePatchTypes.map(({ objc, value }) => `PushyType${objc} = ${value},`)
);

// Sync storage keys.
region(
  `${javaDir}/SyncCoordinator.java`,
  'storage-keys',
  syncStorageKeys.flatMap(({ name, value, doc }) => [
    ...comment(doc, 4),
    `static final String KEY_${snake(name)} = "${value}";`,
  ])
);
region(
  `${ets}/SyncCoordinator.ts`,
  'storage-keys',
  syncStorageKeys.flatMap(({ name, value, doc }) => [
    ...comment(doc),
    `export const KEY_${snake(name)} = '${value}';`,
  ])
);

// Round statuses.
region(
  `${javaDir}/BundlePreparationResult.java`,
  'statuses',
  roundStatuses.map(
    ({ name, value }) => `public static final String ${snake(name)} = "${value}";`
  )
);

// Android ABIs.
region('android/jni/Application.mk', 'abis', [`APP_ABI := ${androidAbis.join(' ')}`]);
const quotedList = (values: string[]) => values.map((value) => `'${value}',`);
region('scripts/check-packlist.js', 'abis', [
  `const requiredAbis = [${androidAbis.map((abi) => `'${abi}'`).join(', ')}];`,
]);
region('scripts/verify-android-so.js', 'abis', [
  `const ABIS = [${androidAbis.map((abi) => `'${abi}'`).join(', ')}];`,
]);

// Vendored decoder sources.
// The whole assignment: a comment line would end a backslash continuation.
region('android/jni/Android.mk', 'vendored-sources', [
  'Hdp_Files := \\',
  ...vendoredSources.map(
    (path, i) =>
      `\t${path.replace('android/jni/', '')}${i < vendoredSources.length - 1 ? ' \\' : ''}`
  ),
]);
region(
  'harmony/pushy/src/main/cpp/CMakeLists.txt',
  'vendored-sources',
  vendoredSources.map((path) =>
    path
      .replace('android/jni/HDiffPatch', '${HDIFFPATCH_DIR}')
      .replace('android/jni/lzma', '${LZMA_DIR}')
  )
);
region('scripts/check-packlist.js', 'vendored-sources', quotedList(vendoredSources));
region('scripts/check-packlist.js', 'vendored-compile', quotedList(vendoredSources));
region(
  'scripts/test-patch-core.sh',
  'vendored-sources',
  vendoredSources.map((path) => {
    const object = path.split('/').pop()?.replace(/\.c$/, '.o');
    return `cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/${path}" -o "$BUILD_DIR/${object}"`;
  })
);

// Harmony method table and the old-architecture spec, from src/NativePushy.ts.
const spec = specMethods();
const plumbing = new Set(['getConstants', 'addListener', 'removeListeners']);
const tableRows = spec.map(({ name, params, promise }) => {
  if (!promise && !plumbing.has(name)) {
    throw new Error(`src/NativePushy.ts: ${name} must return a Promise`);
  }
  return `X(${name}, ${params.length}, ${promise ? 'ASYNC' : 'SYNC'})`;
});
const tableWidth = Math.max(...tableRows.map((row) => row.length)) + 1;
region('harmony/pushy/src/main/cpp/PushyTurboModule.cpp', 'pushy-methods', [
  `${'#define PUSHY_METHODS(X)'.padEnd(tableWidth + 2)}\\`,
  ...tableRows.map(
    (row, i) => `  ${i < tableRows.length - 1 ? `${row.padEnd(tableWidth)}\\` : row}`
  ),
]);
region(
  'android/src/oldarch/cn/reactnative/modules/update/NativePushySpec.java',
  'spec-methods',
  spec
    .filter(({ name }) => name !== 'getConstants')
    .flatMap(({ name, params, promise }, i) => [
      ...(i > 0 ? [''] : []),
      `public abstract void ${name}(${[
        ...params.map((param) => `${param.java} ${param.name}`),
        ...(promise ? ['Promise promise'] : []),
      ].join(', ')});`,
    ])
);

// JNI registration table and prototypes, from the Java natives.
const natives = javaNatives();
const nativeKeys = natives.map(({ className, name }) => `${className}.${name}`);
for (const key of nativeKeys) {
  if (!jniFunctions[key]) {
    throw new Error(`${key}: no C++ function in scripts/contract.ts jniFunctions`);
  }
}
for (const key of Object.keys(jniFunctions)) {
  if (!nativeKeys.includes(key)) {
    throw new Error(`scripts/contract.ts jniFunctions: ${key} is not a Java native`);
  }
}
const descriptor = (type: string): string => {
  const array = type.endsWith('[]');
  const base = array ? type.slice(0, -2) : type;
  const primitives: Record<string, string> = {
    boolean: 'Z',
    byte: 'B',
    int: 'I',
    long: 'J',
    double: 'D',
    float: 'F',
    void: 'V',
  };
  const element =
    primitives[base] ??
    (base === 'String' ? 'Ljava/lang/String;' : `L${javaPackage}${base};`);
  return array ? `[${element}` : element;
};
const jniType = (type: string): string => {
  const scalars: Record<string, string> = {
    boolean: 'jboolean',
    byte: 'jbyte',
    int: 'jint',
    long: 'jlong',
    double: 'jdouble',
    float: 'jfloat',
    void: 'void',
    String: 'jstring',
    'boolean[]': 'jbooleanArray',
    'byte[]': 'jbyteArray',
    'int[]': 'jintArray',
    'long[]': 'jlongArray',
    'double[]': 'jdoubleArray',
  };
  return scalars[type] ?? (type.endsWith('[]') ? 'jobjectArray' : 'jobject');
};
const lowerSnake = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const ordered = Object.keys(jniFunctions).map(
  (key) => natives[nativeKeys.indexOf(key)]
);
region(
  'cpp/android_jni/jni_natives.h',
  'prototypes',
  ordered.map(
    ({ className, name, returns, params }) =>
      `${jniType(returns)} ${jniFunctions[`${className}.${name}`]}(${[
        'JNIEnv* env',
        'jclass',
        ...params.map((param) => `${jniType(param.type)} ${lowerSnake(param.name)}`),
      ].join(', ')});`
  )
);
const classes = [...new Set(ordered.map(({ className }) => className))];
region(
  'cpp/android_jni/jni_registration.cpp',
  'natives',
  classes.flatMap((className) => [
    `{"${encodeNativeText(`${javaPackage}${className}`)}",  // ${className}`,
    ' {',
    ...ordered
      .filter((native) => native.className === className)
      .flatMap(({ name, returns, params }) => [
        `     {"${encodeNativeText(name)}", "${encodeNativeText(
          `(${params.map((param) => descriptor(param.type)).join('')})${descriptor(returns)}`
        )}",`,
        `      reinterpret_cast<void*>(&pushy::jni_natives::${jniFunctions[`${className}.${name}`]})},`,
      ]),
    ' }},',
  ])
);

// NAPI exports, from NativePatchCore.ts.
const bindings = napiBindings();
for (const name of bindings) {
  if (!napiFunctions[name]) {
    throw new Error(`NativePatchCore.ts ${name}: no NAPI callback in scripts/contract.ts`);
  }
}
for (const name of Object.keys(napiFunctions)) {
  if (!bindings.includes(name)) {
    throw new Error(`scripts/contract.ts napiFunctions: ${name} is not a NativePatchCore binding`);
  }
}
region(
  'harmony/pushy/src/main/cpp/pushy.cpp',
  'exports',
  bindings.map(
    (name, i) =>
      `${i === 0 ? 'if (!' : '    !'}ExportFunction(env, exports, "${name}", Guarded<${napiFunctions[name]}>)${
        i === bindings.length - 1 ? ') {' : ' ||'
      }`
  )
);

// --- Apply -----------------------------------------------------------------

const check = process.argv.includes('--check');
const stale: string[] = [];
for (const [file, named] of Object.entries(regions)) {
  const original = read(file);
  const lines = original.split('\n');
  for (const [name, content] of Object.entries(named)) {
    const open = lines.findIndex((line) => line.includes(`<generated:${name}>`));
    const close = lines.findIndex((line) => line.includes(`</generated:${name}>`));
    if (open < 0 || close < open) {
      throw new Error(`${file}: missing <generated:${name}> markers`);
    }
    const indent = lines[open].match(/^\s*/)?.[0] ?? '';
    const body = content.map((line) =>
      line === '' || line.startsWith('\t') ? line : indent + line
    );
    lines.splice(open + 1, close - open - 1, ...body);
  }
  const updated = lines.join('\n');
  if (updated !== original) {
    stale.push(file);
    if (!check) {
      writeFileSync(join(root, file), updated);
    }
  }
}

const total = Object.values(regions).reduce(
  (sum, named) => sum + Object.keys(named).length,
  0
);
if (check && stale.length > 0) {
  console.error(
    'generate-contract: stale generated regions (run `bun scripts/generate-contract.ts`):'
  );
  for (const file of stale) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}
console.log(
  check
    ? `generate-contract: ${total} generated regions are up to date`
    : `generate-contract: ${stale.length ? `rewrote ${stale.join(', ')}` : 'nothing to change'}`
);
