#!/usr/bin/env python3
"""Compile production Objective-C++ methods in a Foundation-only test host.

No generated source is checked in. Bodies, signatures and source locations come
from the ios/RCTPushy sources (SOURCES) on every run. Extraction fails on missing/ambiguous definitions;
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
# RCTPushyCommon.h); the test host compiles everything in one unit. The
# header's `extern PUSHY_HIDDEN` declarations never match: they start with
# `extern`.
LINKAGE = r'(?:static|PUSHY_HIDDEN)'


def function(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^{LINKAGE}\b[^\n;]*?\b{re.escape(name)}\s*\(', name)


def method(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^\+\s*\([^\n)]*\)\s*{re.escape(name)}\b', name)


def exported_method(source: str, name: str) -> tuple[int, str]:
    return definition(source, rf'^RCT_EXPORT_METHOD\(\s*{re.escape(name)}\s*:', name)


def struct(source: str, name: str) -> tuple[int, str]:
    line, text = definition(source, rf'^struct\s+{re.escape(name)}\b', name)
    return line, text + ';'


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
    'keyNativeCheckCache', 'BUNDLE_FILE_NAME', 'ERROR_OPTIONS',
    'pushyStateLock', 'ignoreRollback', 'pushyIsUsingBundleUrl',
    'pushyResetGeneration', 'pushyNativeConfigGeneration', 'pushyLaunchVersion',
    'pushyCrashHoldActive', 'pushyPurgeRestoreActive', 'pushyPurgeRestoreWindowOpen',
    'pushyHostRoundResult', 'kPushyPurgeRestoreBudget', 'kPushyPurgeRestoreMinimumBudget',
]
HELPERS = [
    # The exception boundary every entry point uses (CODE_AUDIT 4.4).
    'PushyCaughtReason', 'PushyGuard',
    'PushyWithStateLock', 'PushyToStdString', 'PushyFromStdString', 'KeyPackageUpdatedMarked',
    # What reset / binary upgrade delete (generated from scripts/contract.ts).
    'PushyKeysClearedOnReset', 'PushyKeyPrefixesClearedOnReset', 'PushyKeysClearedOnUpgrade',
    'PushyKeyPrefixesClearedOnUpgrade', 'PushyRemoveKeys',
    'PushyJsonDictionary', 'PushyJsonString', 'PushyRejectCaught', 'PushyFileQueue',
    'PushySetNullableString', 'PushyHashInfoKey', 'PushyBinaryIdentityValue',
    'PushyStateFromDefaults', 'PushyApplyStateToDefaults', 'PushySwitchVersionLocked',
    # Canonical config equality (contract C1): the binding over
    # flowcore::ConfigsEquivalent, tested directly.
    'PushyConfigsEquivalent',
    # What switchVersion:error: needs around the shared record core
    # (cpp/patch_core/install_record.cpp, compiled from CORE_SOURCE).
    'PushyVersionDir', 'PushyStringIsBlank', 'PushyIsSafePathComponent',
    # The activation gate switchVersion:error: and the round commit share.
    'PushyIsCurrentOrLastLocked', 'PushyVerifyActivation',
    'PushyVerifiedActivationUnchangedLocked',
]
# The round adapter (round_replay_test.mm): RCTPushyOrchestrator's runOnce and
# the methods that run the engine's commands, compiled in their own host
# against a scripted engine. Their globals and pure helpers come along; the
# IO collaborators are the host's.
ROUND_GLOBALS = [
    'keyNativeConfig', 'keyNativeCheckIncomplete', 'pushyResetGeneration',
    'pushyNativeConfigGeneration', 'pushyCrashHoldActive', 'pushyPurgeRestoreActive',
    'pushyHostRoundResult', 'pushyHostRoundConfig', 'pushyHostRoundGeneration',
    'pushyHostRoundConfigGeneration', 'pushyUnactivatedHash', 'pushyUnactivatedGeneration',
    'pushyUnactivatedConfigGeneration',
]
ROUND_HELPERS = ['PushyToStdString', 'PushyFromStdString', 'PushyJsonDictionary',
                 'PushyHostResult', 'PushyWaitSeconds']
ROUND_METHODS = ['runOnce', 'perform', 'download', 'commit', 'finishRound']
# Emitted ahead of HELPERS, which use them.
STRUCTS: list[str] = ['PushyVerifiedActivation']
# The completion record core switchVersion:error: calls. Copied (with #line)
# into the build directory so the record mutants below can alter it; the
# test script compiles the copy instead of the checkout's file.
CORE_SOURCE = Path('cpp/patch_core/install_record.cpp')
CORE_MUTATIONS = ('trust-digestless', 'grandfather-recorded')
# Mutate the round adapter (round.inc) instead of the purge-restore methods.
ROUND_MUTATIONS = ('drop-config-changed',)
MUTATIONS = ('late-activation', 'skip-reresolve', 'ignore-reset',
             'skip-commit-verify') + CORE_MUTATIONS + ROUND_MUTATIONS


def mutate(text: str, mutation: str) -> str:
    """Negative controls: prove each regression is detected, never ship a mutant."""
    patterns = {
        'late-activation': (r'\bactivation = nil;', '(void)activation;'),
        'skip-reresolve': (r'\breturn YES;', 'return !timedOut;'),
        'ignore-reset': (
            r'if \(pushyResetGeneration\.load\(\) != generation\)\s*\{\s*return;\s*\}',
            '(void)generation;'),
        # Trust a schema-1 record without bundleSha256.
        'trust-digestless': (
            r'(if \(record\.bundle_sha256\.empty\(\)\) \{\s*)return RecordMismatch\(version_hash\);',
            r'\1return Status::Ok();'),
        # Grandfather current/last versions even when they carry a record.
        'grandfather-recorded': (
            r'if \(grandfathered && state == Record::State::kAbsent\)', 'if (grandfathered)'),
        # Report a commit lost to a config change as an ordinary reset.
        'drop-config-changed': (
            r'event\.Set\("reason", flowjson::Value::String\("config_changed"\)\);',
            '(void)configGeneration;'),
        # Activate from the round commit without the activation gate (both
        # the out-of-lock verification and the under-lock re-check).
        'skip-commit-verify': [
            (r'if \(hashToActivate != nil\) \{', 'if (false) {'),
            (r'if \(activation != nil && !PushyVerifiedActivationUnchangedLocked\(verified\)\)',
             'if (false)'),
        ],
    }
    steps = patterns[mutation]
    if isinstance(steps, tuple):
        steps = [steps]
    mutated = text
    for pattern, replacement in steps:
        mutated, count = re.subn(pattern, replacement, mutated)
        if count != 1:
            raise ValueError(f'{mutation}: expected one mutation site, found {count}')
    return mutated


# The sources the module is split across (see RCTPushyInternal.h).
SOURCES = ('RCTPushyInternal.h', 'RCTPushy.mm', 'RCTPushy+Launch.mm', 'RCTPushyState.mm',
           'RCTPushyInstallRecord.mm', 'RCTPushyInstaller.mm', 'RCTPushyOrchestrator.mm')


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
    helpers = [locate(sources, function, name) for name in HELPERS]
    switch_version = locate(sources, method, 'switchVersion')
    core_path = (source_dir / '..' / '..' / CORE_SOURCE).resolve()
    core = core_path.read_text(encoding='utf-8')
    round_methods = [locate(sources, method, name) for name in ROUND_METHODS]
    if mutation in ROUND_MUTATIONS:
        round_methods = [(path, line, mutate(text, mutation) if name == 'commit' else text)
                         for name, (path, line, text) in zip(ROUND_METHODS, round_methods)]
    elif mutation in CORE_MUTATIONS:
        core = mutate(core, mutation)
    elif mutation == 'skip-reresolve':
        restore = (restore[0], restore[1], mutate(restore[2], mutation))
    elif mutation:
        commit = (commit[0], commit[1], mutate(commit[2], mutation))
    sections = {
        'globals.inc': [locate(sources, declaration, name) for name in GLOBALS],
        'helpers.inc': [locate(sources, struct, name) for name in STRUCTS] + helpers,
        'pushy.inc': [locate(sources, method, 'bundleURL'),
                      locate(sources, method, 'resolveLaunchBundleURL'),
                      locate(sources, exported_method, 'resetToPackagedBundle')],
        'installer.inc': [switch_version],
        # The launch wait helper precedes restorePurgedLaunch so the host's
        # dispatch seams apply to it as well.
        'orchestrator.inc': [locate(sources, function, 'PushyWaitSeconds'), restore, commit],
        'round_globals.inc': [locate(sources, declaration, name) for name in ROUND_GLOBALS],
        'round_helpers.inc': [locate(sources, function, name) for name in ROUND_HELPERS],
        'round.inc': round_methods,
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, snippets in sections.items():
        output.joinpath(name).write_text(''.join(
            f'#line {line} {json.dumps(str(path.resolve()))}\n{text}\n\n'
            for path, line, text in snippets
        ), encoding='utf-8')
    output.joinpath(CORE_SOURCE.name).write_text(
        f'#line 1 {json.dumps(str(core_path))}\n{core}', encoding='utf-8')


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
