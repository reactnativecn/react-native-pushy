// Shared test scaffolding for the JS client/provider tests. Module mocks
// installed here follow setup.ts's rule (they live for one test) and always
// pass the real module namespace through, so a mock that outlives its test
// can never leave a module with missing exports behind.
import { afterAll, afterEach, mock } from 'bun:test';
import { baseReactNative, realProjectModules } from './setup';

export const createJsonResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  }) as Response;

/** Lets pending promise callbacks and zero-delay timers run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const devGlobal = globalThis as { __DEV__?: boolean };

/**
 * Sets __DEV__ for the calling test file (call at its top level, before the
 * modules under test are imported) and restores it after the file's tests.
 */
export const setDevForFile = (value: boolean) => {
  const original = devGlobal.__DEV__;
  devGlobal.__DEV__ = value;
  afterAll(() => {
    devGlobal.__DEV__ = original;
  });
};

/** Restores __DEV__ after every test of the calling file. */
export const restoreDevAfterEach = () => {
  const original = devGlobal.__DEV__;
  afterEach(() => {
    devGlobal.__DEV__ = original;
  });
};

/** setup.ts's react-native stand-in with another Platform. */
export const mockPlatform = (Platform: Record<string, unknown>) => {
  mock.module('react-native', () => ({ ...baseReactNative(), Platform }));
};

/**
 * i18n whose `t` returns the key, plus the JSON-encoded params when
 * `withParams` is set. Returns the setLocale mock.
 */
export const mockI18n = ({
  withParams = false,
  setLocale = mock(() => {}),
}: {
  withParams?: boolean;
  setLocale?: ReturnType<typeof mock>;
} = {}) => {
  mock.module('../i18n', () => ({
    default: {
      t: (key: string, params?: Record<string, unknown>) =>
        withParams && params ? `${key}${JSON.stringify(params)}` : key,
      setLocale,
    },
  }));
  return setLocale;
};

/**
 * ../core for a client under test: the real module namespace with the native
 * module, the native constants and nativeMethod (bound to that native
 * module) replaced. `overrides` replace any other export.
 */
export const mockCore = ({
  PushyModule = {},
  ...overrides
}: { PushyModule?: Record<string, unknown> } & Record<
  string,
  unknown
> = {}) => {
  const realCore = realProjectModules['../core'];
  mock.module('../core', () => ({
    ...realCore,
    buildTime: '2023-01-01',
    cInfo: { rnu: '10.0.0', rn: '0.73.0', os: 'ios', uuid: 'uuid' },
    currentVersion: 'hash',
    currentVersionInfo: {},
    isFirstTime: false,
    isRolledBack: false,
    packageVersion: '1.0.0',
    pushyNativeEventEmitter: {
      addListener: mock(() => ({ remove: mock(() => {}) })),
    },
    rolledBackVersion: '',
    setLocalHashInfo: mock(() => {}),
    supportedDiffVersion: 2,
    getBundleHash: mock(() => ''),
    getCurrentVersionInfo: async () => ({}),
    ...overrides,
    PushyModule,
    UpdateModule: PushyModule,
    nativeMethod: (name: string) =>
      realCore.bindNativeMethod(PushyModule, name),
  }));
};

let freshImports = 0;

/**
 * A fresh client module per call: the client is a process-level singleton
 * (module state), so every test gets its own instance of it and of
 * sharedState. Picks up the module mocks installed before the call. Typed
 * loosely on purpose: tests reach into private members.
 */
export const importFreshClient = (): Promise<any> =>
  import(`../client?fresh-${++freshImports}`);

/** A client from a fresh client module; appKey defaults to 'demo-app'. */
export const createClient = async (
  options: Record<string, any> = {},
  type: 'Pushy' | 'Cresc' = 'Pushy'
) => {
  const module = await importFreshClient();
  const client = new module[type]({ appKey: 'demo-app', ...options });
  return { client, sharedState: module.sharedState, module };
};
