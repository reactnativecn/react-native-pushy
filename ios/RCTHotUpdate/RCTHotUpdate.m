//
//  RCTHotUpdate.m
//  RCTHotUpdate
//
//  Created by LvBingru on 2/19/16.
//  Copyright © 2016 erica. All rights reserved.
//

#import "RCTHotUpdate.h"
#import "ZipArchive.h"
#import "RCTHotUpdateDownloader.h"
#import "RCTEventDispatcher.h"
#import "RCTConvert.h"

@implementation RCTHotUpdate

@synthesize bridge = _bridge;
@synthesize methodQueue = _methodQueue;

RCT_EXPORT_MODULE(RCTHotUpdate);

- (NSDictionary *)constantsToExport
{
    return @{ @"downloadRootDir": [self constDir] };
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        
    }
    return self;
}

RCT_EXPORT_METHOD(checkForUpdate:(NSDictionary *)options callback:(RCTResponseSenderBlock)callback)
{
//    dispatch_queue_t fileOpQueue = dispatch_queue_create("reactnative.cn.hotupdate", DISPATCH_QUEUE_SERIAL);
}

RCT_EXPORT_METHOD(downloadUpdate:(NSDictionary *)options callback:(RCTResponseSenderBlock)callback)
{
    NSString *updateUrl = options[@"updateUrl"];
    NSString *unzipName = options[@"unzipName"]?:@"unzipped";
    
    NSString *dir = [self getDownloadDir];
    NSString *savePath = [dir stringByAppendingPathComponent:@"zipfile"];

    [RCTHotUpdateDownloader download:updateUrl savePath:savePath progressHandler:^(long long receivedBytes, long long totalBytes) {
        [self.bridge.eventDispatcher sendAppEventWithName:@"RCTHotUpdateDownloadProgress"
                                     body:@{
                                            @"receivedBytes":[NSNumber numberWithLongLong:receivedBytes],
                                            @"totalBytes":[NSNumber numberWithLongLong:totalBytes]
                                            }];
    } completionHandler:^(NSString *path, NSError *error) {
        if (error) {
            callback(@[error.description]);
        }
        else {
            NSString *unzipFilePath = [dir stringByAppendingPathComponent:unzipName];
            [SSZipArchive unzipFileAtPath:savePath toDestination:unzipFilePath progressHandler:^(NSString *entry, unz_file_info zipInfo, long entryNumber, long total) {
                [self.bridge.eventDispatcher sendAppEventWithName:@"RCTHotUpdateUnzipProgress"
                                                             body:@{
                                                                    @"receivedBytes":[NSNumber numberWithLong:entryNumber],
                                                                    @"totalBytes":[NSNumber numberWithLong:total]
                                                                    }];
                
                //            NSLog(@"%ld %ld", entryNumber, total);
            } completionHandler:^(NSString *path, BOOL succeeded, NSError *error) {
                if (error) {
                    callback(@[error.description]);
                }
                else {
                    callback(@[[NSNull null]]);
                }
            }];
        }
    }];
}

RCT_EXPORT_METHOD(setNeedUpdate:(NSDictionary *)options)
{
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options)
{
}

#pragma mark - private

- (NSString *)donwloadDirPath
{
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    NSString *downloadDir = [directory stringByAppendingPathComponent:@"reactnativecnhotupdate"];

    return downloadDir;
}

- (NSString *)constDir
{
    NSString *downloadDir = [self donwloadDirPath];
    NSFileManager *fileManager = [NSFileManager defaultManager];
    BOOL isDir;
    if ([fileManager fileExistsAtPath:downloadDir isDirectory:&isDir]) {
        if (isDir) {
            return downloadDir;
        }
    }
    
    return @"";
}

- (NSString *)getDownloadDir
{
    NSString *downloadDir = [self donwloadDirPath];
    
    NSFileManager *fileManager = [NSFileManager defaultManager];
    
    BOOL isDir;
    if ([fileManager fileExistsAtPath:downloadDir isDirectory:&isDir]) {
        if (isDir) {
            return downloadDir;
        }
    }
    
    NSError *error;
    if (![fileManager createDirectoryAtPath:downloadDir
                withIntermediateDirectories:YES
                                 attributes:nil
                                      error:&error])
    {
        return nil;
    }
    
    return downloadDir;
}

@end
