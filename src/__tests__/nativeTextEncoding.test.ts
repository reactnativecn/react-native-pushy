import { describe, expect, test } from 'bun:test';
import { normalizePushyConfiguration } from '../../harmony/pushy/src/main/ets/PushyConfiguration';
import { QUERY_PATH, revealText } from '../../harmony/pushy/src/main/ets/Texts';
import {
  decodeNativeText,
  encodeNativeText,
} from '../../scripts/encode-native-text';
import { shippedNativeSources, source, stripComments } from './nativeSources';

// Service addresses and the request path must only appear encoded in shipped
// native code (see scripts/encode-native-text.ts).
const plainTexts = [
  '/checkUpdate/',
  'https://update.react-native.cn/api',
  'https://update.reactnative.cn/api',
  'https://gitee.com/sunnylqm/react-native-pushy/raw/master/endpoints.json',
  'https://cdn.jsdelivr.net/gh/reactnativecn/react-native-update@master/endpoints.json',
];

const paths = [
  'ios/',
  'android/src/main/',
  'harmony/pushy/src/main/',
  'cpp/',
].flatMap(shippedNativeSources);

const encodedIn = (text: string) =>
  [
    ...text.matchAll(
      /\b(?:reveal|RCTPushyRevealText|revealText|RevealStatic|Reveal)\(\s*["']([0-9a-f]+)["']\s*\)/g
    ),
  ].map((match) => match[1]);

describe('native text encoding', () => {
  test('encoding round-trips', () => {
    for (const text of plainTexts) {
      expect(decodeNativeText(encodeNativeText(text))).toBe(text);
      expect(revealText(encodeNativeText(text))).toBe(text);
    }
  });

  test('each platform encodes the service addresses and path', () => {
    const platforms = {
      android: paths.filter((path) => path.startsWith('android/')),
      ios: paths.filter((path) => path.startsWith('ios/')),
      harmony: paths.filter((path) => path.startsWith('harmony/')),
    };
    for (const [platform, files] of Object.entries(platforms)) {
      const decoded = files
        .flatMap((path) => encodedIn(source(path)))
        .map(decodeNativeText)
        .sort();
      for (const text of plainTexts) {
        expect({ platform, text, found: decoded.includes(text) }).toEqual({
          platform,
          text,
          found: true,
        });
      }
    }
  });

  test('shipped native code has no plain service addresses or paths', () => {
    const offenders = paths.flatMap((path) => {
      const code = stripComments(source(path));
      return plainTexts
        .filter((text) => code.includes(text))
        .map((text) => `${path}: ${text}`);
    });
    expect(offenders).toEqual([]);
  });

  test('Harmony resolves the path and default addresses at runtime', () => {
    expect(QUERY_PATH).toBe('/checkUpdate/');
    const config = JSON.parse(normalizePushyConfiguration({ appKey: 'k' }));
    expect(config.endpoints).toEqual(plainTexts.slice(1, 3));
    expect(config.queryUrls).toEqual(plainTexts.slice(3));
  });

  // Every string literal in shipped native code, comments excluded: none may
  // carry update/patch/rescue/reload wording except the entries below, which
  // are fixed by a contract that cannot change without breaking callers.
  test('shipped native string literals carry no update wording', () => {
    const allowed = [
      // Public host API constant (Java switch/case needs a compile-time constant).
      'android/src/main/java/cn/reactnative/modules/update/BundlePreparationResult.java: noUpdate',
      // Public ArkTS option type (compile-time only).
      'harmony/pushy/src/main/ets/PushyConfiguration.ts: setNeedUpdate',
    ];
    const wording = /update|patch|rescue|reload|hotfix/i;
    const literal =
      /@?"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g;
    const offenders = paths.flatMap((path) =>
      stripComments(source(path))
        .split('\n')
        .filter(
          (line) =>
            !/^\s*(?:#\s*(?:import|include)|import\b|}\s*from\b)/.test(line)
        )
        .filter((line) => !/__has_include/.test(line))
        .flatMap((line) =>
          [...line.matchAll(literal)]
            .map((match) =>
              (match[1] ?? match[2] ?? match[3] ?? '').replace(
                /\$\{[^}]*\}/g,
                ''
              )
            )
            .filter((value) => wording.test(value))
            .map((value) => `${path}: ${value}`)
        )
        .filter((entry) => !allowed.includes(entry))
    );
    expect(offenders).toEqual([]);
  });
});
