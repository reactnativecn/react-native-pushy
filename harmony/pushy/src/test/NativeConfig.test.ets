import { describe, it, expect } from '@ohos/hypium';
import { canonicalNativeConfig, nativeConfigsEquivalent } from '../main/ets/UpdateContext';

// C1:跨平台配置等价规则(与 JS/Android/iOS 一致)。
export default function nativeConfigTest() {
  describe('nativeConfigsEquivalent', () => {
    it('ignores key order', 0, () => {
      expect(nativeConfigsEquivalent(
        '{"appKey":"k","endpoints":["https://a"]}',
        '{"endpoints":["https://a"],"appKey":"k"}',
      )).assertTrue();
    });

    it('fills absent keys with their defaults', 0, () => {
      expect(nativeConfigsEquivalent(
        '{"appKey":"k"}',
        '{"appKey":"k","disabled":false,"queryUrls":[],"rnu":"","rn":"","afterDownload":"none"}',
      )).assertTrue();
      expect(nativeConfigsEquivalent('{"appKey":"k"}', '{"appKey":"k","disabled":true}'))
        .assertFalse();
      expect(nativeConfigsEquivalent('{"appKey":"k"}', '{"appKey":"k","rn":"0.82"}'))
        .assertFalse();
    });

    it('strips trailing slashes and dedupes URL lists, keeping first order', 0, () => {
      expect(nativeConfigsEquivalent(
        '{"appKey":"k","endpoints":["https://a/","https://b","https://a"],"queryUrls":["https://q/"]}',
        '{"appKey":"k","endpoints":["https://a","https://b"],"queryUrls":["https://q"]}',
      )).assertTrue();
      expect(nativeConfigsEquivalent(
        '{"appKey":"k","endpoints":["https://a","https://b"]}',
        '{"appKey":"k","endpoints":["https://b","https://a"]}',
      )).assertFalse();
      // Every trailing slash goes, not just one.
      expect(nativeConfigsEquivalent(
        '{"appKey":"k","endpoints":["https://b.example.com//"]}',
        '{"appKey":"k","endpoints":["https://b.example.com"]}',
      )).assertTrue();
    });

    it('treats unparseable or non-object JSON as not equivalent', 0, () => {
      expect(nativeConfigsEquivalent('{', '{"appKey":"k"}')).assertFalse();
      expect(nativeConfigsEquivalent('[]', '{}')).assertFalse();
      // Not even against itself: only JSON objects have a canonical form.
      expect(nativeConfigsEquivalent('{', '{')).assertFalse();
      expect(nativeConfigsEquivalent('"x"', '"x"')).assertFalse();
      expect(nativeConfigsEquivalent(undefined, '{"appKey":"k"}')).assertFalse();
      expect(canonicalNativeConfig('null') === undefined).assertTrue();
    });

    it('compares every other field exactly', 0, () => {
      expect(nativeConfigsEquivalent('{"appKey":"k"}', '{"appKey":"k2"}')).assertFalse();
      expect(nativeConfigsEquivalent(
        '{"appKey":"k","packageVersion":"1"}',
        '{"appKey":"k"}',
      )).assertFalse();
    });
  });
}
