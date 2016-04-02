//
//  BSDiff.h
//  RCTHotUpdate
//
//  Created by lvbingru on 16/4/2.
//  Copyright © 2016年 erica. All rights reserved.
//

#import <Foundation/Foundation.h>

@interface BSDiff : NSObject

+ (BOOL)bsdiffPatch:(NSString *)path
             origin:(NSString *)origin
      toDestination:(NSString *)destination;
@end
