// Internal to the RCTPushy pod and Foundation-only: what every translation
// unit shares, including RCTPushyConfiguration.mm and RCTPushyDownloader.mm,
// which compile without React Native (the purge-restore test host builds
// RCTPushyConfiguration.mm on its own). Not a public header.
#pragma once

#import <Foundation/Foundation.h>

// Shared across the pod's translation units, never exported from a dynamic
// framework.
#ifndef PUSHY_HIDDEN
#define PUSHY_HIDDEN __attribute__((visibility("hidden")))
#endif

// Every NSError this pod creates: the domain, and the userInfo key carrying
// the stable cross-platform code (cpp/patch_core/error_codes.h).
static NSString *const RCTPushyErrorDomain = @"cn.reactnative.pushy";
static NSString *const RCTPushyErrorCodeKey = @"PushyErrorCode";

// Whether following a redirect from `from` to `to` would leave https for
// plaintext http. Every https request (check and artifact) refuses that
// downgrade before the redirected request is sent.
PUSHY_HIDDEN BOOL RCTPushyIsHttpsDowngrade(NSURL *from, NSURL *to);

// Removes a downloaded archive together with its resume sidecar
// (RCTPushyResumeSidecarPath): nothing may survive to vouch for bytes that
// are gone.
PUSHY_HIDDEN void RCTPushyDiscardArchive(NSString *path);
