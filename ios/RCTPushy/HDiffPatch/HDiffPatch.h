//
//  HDiffPatch.h
//  RCTPushy
//
//  Created by HouSisong, All rights reserved.
//

#import <Foundation/Foundation.h>

@interface HDiffPatch : NSObject

+ (BOOL)hdiffPatch:(NSString *)path
            origin:(NSString *)origin
     toDestination:(NSString *)destination;

@end
