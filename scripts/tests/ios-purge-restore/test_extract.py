import unittest

from extract import (declaration, exported_method, function, mask_literals, method, mutate,
                     struct)


class ExtractionTests(unittest.TestCase):
    def test_preserves_offsets_and_lines(self):
        source = '/* {\n} */ @"escaped \\" { }"; // }\nconst char *x = R"tag({"})tag";'
        masked = mask_literals(source)
        self.assertEqual(len(masked), len(source))
        self.assertEqual(masked.count('\n'), source.count('\n'))
        self.assertNotIn('{', masked)
        self.assertNotIn('}', masked)

    def test_skips_prototype_and_keeps_body_verbatim(self):
        body = 'static void run() {\n  auto block = ^{ @"}"; /* } */ };\n}'
        source = 'static void run();\n// static void run() {}\n' + body
        line, actual = function(source, 'run')
        self.assertEqual(line, 3)
        self.assertEqual(actual, body)

    def test_objc_declaration_and_definition(self):
        source = '+ (BOOL)restore:(id)value;\n+ (BOOL)restore:(id)value { return YES; }'
        self.assertEqual(method(source, 'restore'), (2, source.splitlines()[1]))

    def test_objc_class_method_is_not_an_instance_method(self):
        source = '- (BOOL)switchVersion:(id)h { return NO; }\n+ (BOOL)switchVersion:(id)h { return YES; }'
        self.assertEqual(method(source, 'switchVersion'), (2, source.splitlines()[1]))

    def test_header_extern_is_not_a_definition(self):
        source = ('extern PUSHY_HIDDEN NSString *const key;\n'
                  'PUSHY_HIDDEN NSString *Run(void);\n'
                  'PUSHY_HIDDEN NSString *const key = @"k";\n'
                  'PUSHY_HIDDEN NSString *Run(void) {\n    return key;\n}')
        self.assertEqual(declaration(source, 'key')[0], 3)
        self.assertEqual(function(source, 'Run')[0], 4)

    def test_objc_no_argument_method(self):
        self.assertEqual(method('+ (id)bundleURL\n{ return nil; }', 'bundleURL')[0], 1)

    def test_exported_reset_method(self):
        source = 'RCT_EXPORT_METHOD(reset:(id)resolve\n rejecter:(id)reject)\n{ ^{ @"}"; }; }'
        self.assertEqual(exported_method(source, 'reset')[1], source)

    def test_struct_definition_keeps_its_terminator(self):
        source = 'struct Stamp;\nstruct Stamp {\n  bool ok() const { return true; }\n};'
        self.assertEqual(struct(source, 'Stamp'),
                         (2, 'struct Stamp {\n  bool ok() const { return true; }\n};'))

    def test_static_initializers_and_string_contents(self):
        self.assertEqual(declaration('static std::atomic<bool> active{false};', 'active')[1],
                         'static std::atomic<bool> active{false};')
        text = 'static NSString *const key = @"value;with;semicolons";'
        self.assertEqual(declaration(text, 'key')[1], text)

    def test_missing_duplicate_or_unbalanced_source_fails_closed(self):
        for source in ('static void run();', 'static void run() {',
                       'static void run() {}\nstatic void run() {}'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                function(source, 'run')
        with self.assertRaises(ValueError):
            declaration('static bool other = false;', 'active')

    def test_mutations_fail_on_source_drift(self):
        self.assertEqual(mutate('activation = nil;', 'late-activation'), '(void)activation;')
        self.assertEqual(mutate('return YES;', 'skip-reresolve'), 'return !timedOut;')
        self.assertEqual(
            mutate('if (record.bundle_sha256.empty()) {\n    return RecordMismatch(version_hash);',
                   'trust-digestless'),
            'if (record.bundle_sha256.empty()) {\n    return Status::Ok();')
        self.assertEqual(
            mutate('if (grandfathered && state == Record::State::kAbsent) {', 'grandfather-recorded'),
            'if (grandfathered) {')
        self.assertEqual(
            mutate('event.Set("reason", flowjson::Value::String("config_changed"));',
                   'drop-config-changed'),
            '(void)configGeneration;')
        for source in ('', 'activation = nil; activation = nil;'):
            with self.assertRaises(ValueError):
                mutate(source, 'late-activation')


if __name__ == '__main__':
    unittest.main()
