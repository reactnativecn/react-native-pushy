import { describe, expect, test } from 'bun:test';
import {
  createPushyError,
  ERROR_DELTA_FAILED,
  ERROR_DOWNLOAD_FAILED,
  getErrorMessage,
  PushyError,
  toPushyError,
} from '../../harmony/pushy/src/main/ets/ErrorCodes';

// Stable Harmony error codes: a `code` property plus a `[CODE] ` message
// prefix (the RNOH bridge may drop the property; JS parses the prefix).
describe('harmony ErrorCodes', () => {
  test('createPushyError sets the code and prefixes the message', () => {
    const error = createPushyError(ERROR_DELTA_FAILED, 'boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ERROR_DELTA_FAILED);
    expect(error.message).toBe('[PATCH_FAILED] boom');
  });

  test('toPushyError keeps an existing code and never double-prefixes', () => {
    const original = createPushyError(ERROR_DELTA_FAILED, 'boom');
    const wrapped = toPushyError(original, ERROR_DOWNLOAD_FAILED);
    expect(wrapped).toBe(original);
    expect(wrapped.message).toBe('[PATCH_FAILED] boom');
  });

  test('toPushyError assigns the default code to plain errors and values', () => {
    const fromError = toPushyError(new Error('plain'), ERROR_DOWNLOAD_FAILED);
    expect(fromError.code).toBe(ERROR_DOWNLOAD_FAILED);
    expect(fromError.message).toBe('[DOWNLOAD_FAILED] plain');
    const fromString = toPushyError('raw', ERROR_DOWNLOAD_FAILED);
    expect(fromString).toBeInstanceOf(PushyError);
    expect(fromString.message).toBe('[DOWNLOAD_FAILED] raw');
  });

  test('getErrorMessage reads errors, message objects and primitives', () => {
    expect(getErrorMessage(new Error('e'))).toBe('e');
    expect(getErrorMessage({ message: 'm', code: 42 })).toBe('m');
    expect(getErrorMessage('s')).toBe('s');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
