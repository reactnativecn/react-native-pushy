//
//  BSDiff.m
//  RCTHotUpdate
//
//  Created by lvbingru on 16/4/2.
//  Copyright © 2016年 erica. All rights reserved.
//

#import "BSDiff.h"
#include "bspatch.h"


@implementation BSDiff

+ (BOOL)bsdiffPatch:(NSString *)patch
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
    
    int err = beginPatch([origin UTF8String], [destination UTF8String], [patch UTF8String]);
    if (err) {
        return NO;
    }
    return YES;
}

@end
