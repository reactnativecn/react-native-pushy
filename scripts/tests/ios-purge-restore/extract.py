#!/usr/bin/env python3
"""Compile production Objective-C++ methods in a Foundation-only test host.

No generated source is checked in. Bodies, signatures and source locations come
from RCTPushy.mm on every run. Extraction fails on missing/ambiguous definitions;
strings/comments cannot affect brace matching. Only the test host supplies I/O.
"""

import argparse
import json
from pathlib import Path
import re


TOKENS = re.compile(
    r'//[^\n]*|/\*[\s\S]*?\*/|'
    r'(?:u8|u|U|L)?R"(?P<delimiter>[^\s()\\]{0,16})\([\s\S]*?\)(?P=delimiter)"|'
    r'"(?:\\[\s\S]|[^"\\])*"|\'(?:\\[\s\S]|[^\'\\])*\''
)


def mask_literals(source: str) -> str:
    """Preserve offsets/newlines, hiding comments and string/character literals."""
    return TOKENS.sub(lambda m: re.sub(r'[^\n]', ' ', m.group()), source)


def definition(source: str, pattern: str, label: str) -> tuple[int, str]:
    masked = mask_literals(source)
    definitions = []
    for match in re.finditer(pattern, masked, re.MULTILINE):
        opening = masked.find('{', match.end())
        semicolon = masked.find(';', match.end())
        if opening < 0 or 0 <= semicolon < opening:
            continue  # An interface declaration or a forward declaration.
        depth = 1
        cursor = opening + 1
        while depth and cursor < len(masked):
            depth += (masked[cursor] == '{') - (masked[cursor] == '}')
            cursor += 1
        if depth:
            raise ValueError(f'{label}: unterminated definition')
        definitions.append((source.count('\n', 0, match.start()) + 1,
                            source[match.start():cursor]))
    if len(definitions) != 1:
        raise ValueError(f'{label}: expected one definition, found {len(definitions)}')
    return definitions[0]


# File-local (static) or shared within the pod (PUSHY_HIDDEN, see
# RCTPushyInternal.h); the test host compiles everything in one unit.
LINKAGE = r'(?:static|PUSHY_HIDDEN)'


def function(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^{LINKAGE}\b[^\n;]*?\b{re.escape(name)}\s*\(', name)


def method(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^\+\s*\([^\n)]*\)\s*{re.escape(name)}\b', name)


def exported_method(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^RCT_EXPORT_METHOD\(\s*{re.escape(name)}\s*:', name)


def declaration(source: str, name: str) -> tuple[int, str]:
    matches = list(re.finditer(rf'^{LINKAGE}\b[^\n;]*\b{re.escape(name)}\b[^\n;]*;',
                               mask_literals(source), re.MULTILINE))
    if len(matches) != 1:
        raise ValueError(f'{name}: expected one static declaration, found {len(matches)}')
    match = matches[0]
    return (source.count('\n', 0, match.start()) + 1,
            source[match.start():match.end()])


GLOBALS = [
    'keyPushyInfo', 'paramPackageVersion', 'paramBuildTime',
    'legacyParamPackageVersion', 'legacyParamBuildTime', 'paramLastVersion',
    'paramCurrentVersion', 'paramIsFirstTime', 'paramIsFirstLoadOk', 'keyUuid',
    'keyHashInfo', 'keyFirstLoadMarked', 'keyRolledBackMarked',
    'keyNativeCheckCache', 'BUNDLE_FILE_NAME',
    'pushyStateLock', 'ignoreRollback', 'pushyIsUsingBundleUrl',
    'pushyResetGeneration', 'pushyNativeConfigGeneration', 'pushyLaunchVersion',
    'pushyCrashHoldActive', 'pushyPurgeRestoreActive', 'pushyPurgeRestoreWindowOpen',
    'pushyHostRoundResult', 'kPushyPurgeRestoreBudget', 'kPushyPurgeRestoreMinimumBudget',
]
HELPERS = [
    'PushyRevealOnce', 'KeyPackageUpdatedMarked', 'PushyWithStateLock', 'PushyToStdString', 'PushyFromStdString',
    'PushySetNullableString', 'PushyHashInfoKey', 'PushyBinaryIdentityValue',
    'PushyStateFromDefaults', 'PushyApplyStateToDefaults', 'PushySwitchVersionLocked',
    # Canonical config equality (cross-platform contract), tested directly.
    'PushyNormalizeEndpointBase', 'PushyJsonIsBool', 'PushyJsonEqual',
    'PushyCanonicalUrlList', 'PushyCanonicalConfig', 'PushyConfigsEquivalent',
]
MUTATIONS = ('late-activation', 'skip-reresolve', 'ignore-reset')


def mutate(text: str, mutation: str) -> str:
    """Negative controls: prove each regression is detected, never ship a mutant."""
    patterns = {
        'late-activation': (r'\bactivation = nil;', '(void)activation;'),
        'skip-reresolve': (r'\breturn YES;', 'return !timedOut;'),
        'ignore-reset': (
            r'if \(pushyResetGeneration\.load\(\) != generation\)\s*\{\s*return;\s*\}',
            '(void)generation;'),
    }
    pattern, replacement = patterns[mutation]
    mutated, count = re.subn(pattern, replacement, text)
    if count != 1:
        raise ValueError(f'{mutation}: expected one mutation site, found {count}')
    return mutated


# The sources the module is split across (RCTPushy.mm: module and launch
# resolution; RCTPushyOrchestrator.mm: the native round).
SOURCES = ('RCTPushy.mm', 'RCTPushyOrchestrator.mm')


def locate(sources: list[tuple[Path, str]], extractor, name: str) -> tuple[Path, int, str]:
    """Exactly one definition across all sources; each keeps its own file."""
    found = []
    for path, text in sources:
        try:
            line, snippet = extractor(text, name)
        except ValueError as error:
            if 'found 0' in str(error):
                continue
            raise
        found.append((path, line, snippet))
    if len(found) != 1:
        raise ValueError(f'{name}: expected one definition across sources, found {len(found)}')
    return found[0]


def generate(source_dir: Path, output: Path, mutation: str | None = None) -> None:
    sources = [(source_dir / name, (source_dir / name).read_text(encoding='utf-8'))
               for name in SOURCES]
    restore = locate(sources, method, 'restorePurgedLaunch')
    commit = locate(sources, method, 'commitRoundWithGeneration')
    if mutation == 'skip-reresolve':
        restore = (restore[0], restore[1], mutate(restore[2], mutation))
    elif mutation:
        commit = (commit[0], commit[1], mutate(commit[2], mutation))
    sections = {
        'globals.inc': [locate(sources, declaration, name) for name in GLOBALS],
        'helpers.inc': [locate(sources, function, name) for name in HELPERS],
        'pushy.inc': [locate(sources, method, 'bundleURL'),
                      locate(sources, method, 'resolveLaunchBundleURL'),
                      locate(sources, exported_method, 'resetToPackagedBundle')],
        'orchestrator.inc': [restore, commit],
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, snippets in sections.items():
        output.joinpath(name).write_text(''.join(
            f'#line {line} {json.dumps(str(path.resolve()))}\n{text}\n\n'
            for path, line, text in snippets
        ), encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_dir', type=Path, help='ios/RCTPushy')
    parser.add_argument('output', type=Path)
    parser.add_argument('--mutation', choices=MUTATIONS)
    args = parser.parse_args()
    try:
        generate(args.source_dir, args.output, args.mutation)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Native test extraction failed: {error}\n')


if __name__ == '__main__':
    main()
