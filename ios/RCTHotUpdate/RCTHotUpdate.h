//
//  RCTHotUpdate.h
//  RCTHotUpdate
//
//  Created by LvBingru on 2/19/16.
//  Copyright © 2016 erica. All rights reserved.
//

#if __has_include(<React/RCTBridge.h>)
#import <React/RCTBridgeModule.h>
#else
#import "RCTBridgeModule.h"
#endif

@interface RCTHotUpdate : NSObject<RCTBridgeModule>

+ (NSURL *)bundleURL;

@end
