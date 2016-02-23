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

static NSString *const curVersionKey = @"REACTNATIVECNHOTUPDATECURVERSIONKEY";

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

+ (NSURL *)bundleURL
{
    NSString *downloadDir = [self donwloadDirPath];
    NSString *curVersion = [self loadCurVersion];
    if (curVersion) {
        NSString *bundlePath = [[downloadDir stringByAppendingPathComponent:curVersion] stringByAppendingPathComponent:@"index.bundlejs"];
        
        if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePath isDirectory:NULL]) {
            NSURL *bundleURL = [NSURL fileURLWithPath:bundlePath];
            return bundleURL;
        }
        else {
            return [self mainBundleURL];
        }
    }
    else {
        return [self mainBundleURL];
    }
}

+ (NSURL *)mainBundleURL
{
    NSURL *jsCodeLocation = [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    return jsCodeLocation;
}

RCT_EXPORT_METHOD(downloadUpdate:(NSDictionary *)options callback:(RCTResponseSenderBlock)callback)
{
    NSString *updateUrl = options[@"updateUrl"];
    NSString *hashName = options[@"hashName"]?:@"unzipped";
    
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
            NSString *unzipFilePath = [dir stringByAppendingPathComponent:hashName];
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
    NSString *hashName = options[@"hashName"];
    if (hashName.length) {
        [[self class] saveCurVersion:hashName];
    }
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options)
{
    NSString *hashName = options[@"hashName"];
    if (hashName.length) {
        [[self class] saveCurVersion:hashName];
        dispatch_async(dispatch_get_main_queue(), ^{
            [_bridge setValue:[[self class] bundleURL] forKey:@"bundleURL"];
            [_bridge reload];
        });
    }
}

#pragma mark - private

+ (NSString *)donwloadDirPath
{
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    NSString *downloadDir = [directory stringByAppendingPathComponent:@"reactnativecnhotupdate"];

    return downloadDir;
}

- (NSString *)constDir
{
    NSString *downloadDir = [[self class] donwloadDirPath];
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
    NSString *downloadDir = [[self class] donwloadDirPath];
    
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

+ (void)saveCurVersion:(NSString *)hashCode
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:hashCode forKey:curVersionKey];
    [defaults synchronize];
}

+ (NSString *)loadCurVersion
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *curVersion = [defaults stringForKey:curVersionKey];
    return curVersion;
}

@end
