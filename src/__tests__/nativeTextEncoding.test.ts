import { describe, expect, test } from 'bun:test';
import { revealText } from '../../harmony/pushy/src/main/ets/Texts';
import { nativeTexts, servicePresets } from '../../scripts/contract';
import {
  decodeNativeText,
  encodeNativeText,
} from '../../scripts/encode-native-text';
import { shippedNativeSources, source, stripComments } from './nativeSources';

// Service addresses and the request path must only appear encoded in shipped
// native code (see scripts/encode-native-text.ts). They come from the same
// registry the generated code does (scripts/contract.ts).
const plainTexts = [
  ...nativeTexts
    .filter(({ name }) => name === 'QueryPath')
    .map(({ value }) => value),
  ...servicePresets.Pushy.main,
  ...servicePresets.Pushy.queryUrls,
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
      /\b(?:reveal|revealText|RevealStatic|Reveal)\(\s*["']([0-9a-f]+)["']\s*\)/g
    ),
  ].map((match) => match[1]);

// The text of `code` outside its <generated:NAME> regions.
const handWritten = (code: string) =>
  code.replace(/<generated:([\w-]+)>[\s\S]*?<\/generated:\1>/g, '');

describe('native text encoding', () => {
  test('plain texts are known', () => {
    expect(plainTexts).toContain('/checkUpdate/');
    expect(plainTexts.length).toBeGreaterThan(2);
  });

  test('encoding round-trips', () => {
    for (const text of plainTexts) {
      expect(decodeNativeText(encodeNativeText(text))).toBe(text);
      expect(revealText(encodeNativeText(text))).toBe(text);
    }
  });

  // The request path and the default service addresses live in the generated
  // cpp/patch_core/native_texts.h, used by the shared round core and the
  // shared normalizer.
  test('the request path and the addresses are encoded in cpp/', () => {
    const shared = paths
      .filter((path) => path.startsWith('cpp/'))
      .flatMap((path) => encodedIn(source(path)))
      .map(decodeNativeText);
    for (const text of plainTexts) {
      expect({ text, found: shared.includes(text) }).toEqual({
        text,
        found: true,
      });
    }
  });

  // Encoded text is registered once (scripts/contract.ts) and generated into
  // native_texts.h / Texts.java / Texts.ts (error codes and the JNI table in
  // their own generated regions); a hand-written encoded literal would be an
  // unregistered copy that can drift.
  test('every encoded literal is generated from the registry', () => {
    const offenders = paths.flatMap((path) =>
      encodedIn(stripComments(handWritten(source(path)))).map(
        (hex) => `${path}: ${decodeNativeText(hex)}`
      )
    );
    expect(offenders).toEqual([]);
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
