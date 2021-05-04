//
//  HDiffPatch.m
//  RCTPushy
//
//  Created by HouSisong, All rights reserved.
//

#import "HDiffPatch.h"
#include "../../../android/jni/hpatch.h"

@implementation HDiffPatch

+ (BOOL)hdiffPatch:(NSString *)patch
            origin:(NSString *)origin
     toDestination:(NSString *)destination
{
    if (![[NSFileManager defaultManager] fileExistsAtPath:patch]) {
        return NO;
    }
    if (![[NSFileManager defaultManager] fileExistsAtPath:origin]) {
        return NO;
    }
    
    if ([[NSFileManager defaultManager] fileExistsAtPath:destination]) {
        [[NSFileManager defaultManager] removeItemAtPath:destination error:nil];
    }
    
    int err = hpatch_by_file([origin UTF8String], [destination UTF8String], [patch UTF8String]);
    if (err) {
        return NO;
    }
    return YES;
}

@end
