//
//  RCTPushy.h
//  RCTPushy
//
//  Created by LvBingru on 2/19/16.
//  Copyright © 2016 erica. All rights reserved.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>


@interface RCTPushy : RCTEventEmitter<RCTBridgeModule>

+ (NSURL *)bundleURL;

@end
