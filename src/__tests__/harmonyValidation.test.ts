import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  createPushyError,
  ERROR_INVALID_HASH_INFO,
  type PushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';
import { EventHub } from '../../harmony/pushy/src/main/ets/EventHub';
import {
  assertSafePathComponent,
  isSafePathComponent,
} from '../../harmony/pushy/src/main/ets/PathUtils';

// Harmony input validation (path components, hash info JSON) and the
// download-progress event hub.

// validateHashInfo lives in PushyTurboModule.ts, which extends RNOH's
// UITurboModule: evaluate it with its imports stripped and a stub base class.
const turboModuleSource = readFileSync(
  new URL(
    '../../harmony/pushy/src/main/ets/PushyTurboModule.ts',
    import.meta.url
  ),
  'utf8'
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^export\s*\{[^}]*\}(?:\s*from\s*[^;]*)?;\r?\n/gm, '')
  .replace(/^export /gm, '');
const validateHashInfo = runInNewContext(
  `${new Bun.Transpiler({ loader: 'ts' }).transformSync(turboModuleSource)}\nvalidateHashInfo;`,
  {
    UITurboModule: class {},
    ERROR_INVALID_HASH_INFO,
    createPushyError,
  }
) as (info: string) => void;

function refusal(run: () => unknown): PushyError | null {
  try {
    run();
  } catch (e) {
    return e as PushyError;
  }
  return null;
}

describe('harmony isSafePathComponent', () => {
  test('accepts plain hash-like names', () => {
    expect(isSafePathComponent('a1b2c3d4')).toBe(true);
    expect(isSafePathComponent('origin_hash-1.ppk')).toBe(true);
    expect(assertSafePathComponent('a1b2c3d4')).toBe('a1b2c3d4');
  });

  test('rejects empty, dot and separator-bearing names', () => {
    for (const name of ['', '.', '..', '../etc', 'a/b', 'a\\b', 'a\0b']) {
      expect(isSafePathComponent(name)).toBe(false);
      expect(refusal(() => assertSafePathComponent(name))?.code).toBe(
        'INVALID_OPTIONS'
      );
    }
  });
});

describe('harmony validateHashInfo', () => {
  test('accepts JSON objects', () => {
    expect(refusal(() => validateHashInfo('{"name":"v1"}'))).toBeNull();
    expect(refusal(() => validateHashInfo('{}'))).toBeNull();
  });

  test('rejects arrays, primitives, null and invalid JSON', () => {
    for (const info of ['[1,2,3]', '"hello"', 'null', '{invalid}']) {
      expect(refusal(() => validateHashInfo(info))?.code).toBe(
        ERROR_INVALID_HASH_INFO
      );
    }
  });
});

describe('harmony EventHub', () => {
  test('is a singleton', () => {
    expect(EventHub.getInstance()).toBe(EventHub.getInstance());
  });

  test('emitting without an RN instance is a no-op', () => {
    const hub = EventHub.getInstance();
    hub.setRNInstance(undefined);
    expect(() => hub.emit('test', { foo: 'bar' })).not.toThrow();
  });

  test('forwards events to the RN instance', () => {
    const hub = EventHub.getInstance();
    const events: Array<[string, object]> = [];
    hub.setRNInstance({
      emitDeviceEvent: (event: string, data: object) => {
        events.push([event, data]);
      },
    });
    hub.emit('RCTPushyDownloadProgress', { received: 100, total: 200 });
    expect(events).toEqual([
      ['RCTPushyDownloadProgress', { received: 100, total: 200 }],
    ]);
    hub.setRNInstance(undefined);
  });

  test('clearRNInstance only drops the instance it is given', () => {
    const hub = EventHub.getInstance();
    let calls = 0;
    const current = { emitDeviceEvent: () => calls++ };
    const stale = { emitDeviceEvent: () => calls++ };
    hub.setRNInstance(current);
    hub.clearRNInstance(stale);
    hub.emit('RCTPushyDownloadProgress', { received: 1, total: 2 });
    expect(calls).toBe(1);
    hub.clearRNInstance(current);
    hub.emit('RCTPushyDownloadProgress', { received: 2, total: 2 });
    expect(calls).toBe(1);
  });
});
