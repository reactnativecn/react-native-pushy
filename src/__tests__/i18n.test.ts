import { describe, expect, test } from 'bun:test';

describe('i18n', () => {
  // `../i18n` is globally mocked in setup.ts; a cache-busting specifier loads
  // the real module (a fresh instance per key).
  const getRealI18n = async (cacheKey: string) =>
    (await import(`../i18n?${cacheKey}`))
      .default as typeof import('../i18n').default;

  test('translates in the current locale (default en)', async () => {
    const i18n = await getRealI18n('locale');

    expect(i18n.t('update_failed')).toBe('Update failed');
    i18n.setLocale('zh');
    expect(i18n.t('update_failed')).toBe('更新失败');
    i18n.setLocale('en');
    expect(i18n.t('update_failed')).toBe('Update failed');
  });

  test('an unknown key falls back to the key itself', async () => {
    const i18n = await getRealI18n('missing');

    expect(i18n.t('missing_key' as any)).toBe('missing_key');
  });

  test('string interpolation', async () => {
    const i18n = await getRealI18n('interpolation');

    expect(
      i18n.t('error_http_status', { status: 502, statusText: 'Bad' })
    ).toBe('502 Bad');
    // Missing values leave their placeholder as is.
    expect(i18n.t('error_http_status', { status: 502 })).toBe(
      '502 {{statusText}}'
    );
    expect(i18n.t('error_http_status')).toBe('{{status}} {{statusText}}');
  });
});
