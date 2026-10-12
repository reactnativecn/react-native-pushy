import { describe, expect, test } from 'bun:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { setDevForFile } from './helpers';

// Must set __DEV__ before importing context.ts
setDevForFile(true);

const { useUpdate, UpdateContext } = await import('../context');
const { default: i18n } = await import('../i18n');

const renderHook = <T>(hook: () => T) => {
  const result: { current?: T } = {};
  const Probe = () => {
    result.current = hook();
    return null;
  };
  TestRenderer.act(() => {
    TestRenderer.create(React.createElement(Probe));
  });
  return result;
};

describe('context', () => {
  test('useUpdate throws error when used outside UpdateProvider in __DEV__', () => {
    expect(() => renderHook(() => useUpdate())).toThrow(
      i18n.t('error_use_update_outside_provider')
    );
  });

  test('useUpdate returns context when used inside UpdateProvider', () => {
    const client = {} as any;
    const Probe = () => {
      probed.current = useUpdate();
      return null;
    };
    const probed: { current?: ReturnType<typeof useUpdate> } = {};
    TestRenderer.act(() => {
      TestRenderer.create(
        React.createElement(
          UpdateContext.Provider,
          { value: { client } as any },
          React.createElement(Probe)
        )
      );
    });
    expect(probed.current?.client).toBe(client);
  });
});
