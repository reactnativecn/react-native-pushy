#import "RCTPushyConfiguration.h"
#import "RCTPushyCommon.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/obscured_text.h"
#include "../../cpp/update_flow_core/native_config.h"

NSString *RCTPushyRevealText(const char *hex) {
    // The texts are ASCII (scripts/encode-native-text.ts).
    std::string text = pushy::text::Reveal(hex);
    return [[NSString alloc] initWithBytes:text.data()
                                    length:text.size()
                                  encoding:NSUTF8StringEncoding] ?: @"";
}

// Validation and defaults are the shared core's (flowcore::NormalizeConfiguration,
// also used by Android and Harmony); this only bridges the dictionary.
NSString *RCTPushyNormalizeConfiguration(NSDictionary *options, NSError **error) {
    // Anything NSJSONSerialization cannot write is not a JSON object; the core
    // reports it as such.
    std::string optionsJson;
    if ([options isKindOfClass:NSDictionary.class]
        && [NSJSONSerialization isValidJSONObject:options]) {
        NSData *data = [NSJSONSerialization dataWithJSONObject:options options:0 error:NULL];
        if (data != nil) {
            optionsJson.assign(static_cast<const char *>(data.bytes), data.length);
        }
    }
    std::string config;
    std::string message;
    if (flowcore::NormalizeConfiguration(optionsJson, &config, &message)) {
        NSString *result = [[NSString alloc] initWithBytes:config.data()
                                                    length:config.size()
                                                  encoding:NSUTF8StringEncoding];
        if (result != nil) {
            return result;
        }
        message = "Invalid native configuration: not UTF-8";
    }
    if (error != NULL) {
        *error = [NSError errorWithDomain:RCTPushyErrorDomain code:1 userInfo:@{
            NSLocalizedDescriptionKey: [[NSString alloc] initWithBytes:message.data()
                                                                length:message.size()
                                                              encoding:NSUTF8StringEncoding]
                ?: @"Invalid native configuration",
            RCTPushyErrorCodeKey: @(pushy::error_codes::kInvalidOptions)
        }];
    }
    return nil;
}
