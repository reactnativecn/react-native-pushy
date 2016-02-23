//
//  RCTHotUpdateDownloader.h
//  RCTHotUpdate
//
//  Created by lvbingru on 16/2/23.
//  Copyright © 2016年 erica. All rights reserved.
//

#import <Foundation/Foundation.h>

@interface RCTHotUpdateDownloader : NSObject

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
    progressHandler:(void (^)(long long, long long))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler;

@end
