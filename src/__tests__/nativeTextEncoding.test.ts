import { describe, expect, test } from 'bun:test';
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

  // The request path is appended by the shared round core
  // (cpp/update_flow_core/native_round.cpp) and, until they move to it, by
  // the platforms' own HTTP glue; the default service addresses only live in
  // the shared normalizer (cpp/update_flow_core/native_config.cpp).
  test('the request path and the addresses are encoded in cpp/', () => {
    const decodedIn = (prefix: string) =>
      paths
        .filter((path) => path.startsWith(prefix))
        .flatMap((path) => encodedIn(source(path)))
        .map(decodeNativeText);
    for (const platform of ['harmony/']) {
      expect({
        platform,
        found: decodedIn(platform).includes(plainTexts[0]),
      }).toEqual({
        platform,
        found: true,
      });
    }
    const shared = decodedIn('cpp/');
    for (const text of plainTexts) {
      expect({ text, found: shared.includes(text) }).toEqual({
        text,
        found: true,
      });
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

  test('Harmony resolves the path at runtime', () => {
    expect(QUERY_PATH).toBe('/checkUpdate/');
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
