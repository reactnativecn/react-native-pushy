//
//  RCTHotUpdate.m
//  RCTHotUpdate
//
//  Created by LvBingru on 2/19/16.
//  Copyright © 2016 erica. All rights reserved.
//

#import "RCTHotUpdate.h"
#import "RCTHotUpdateDownloader.h"
#import "RCTEventDispatcher.h"
#import "RCTConvert.h"
#import "RCTHotUpdateManager.h"
#import "RCTLog.h"

//
//static NSString *const curVersionKey = @"REACTNATIVECNHOTUPDATECURVERSIONKEY";
static NSString *const rnHotUpdatePackageInfoKey = @"REACTNATIVECNHOTUPDATEPACKAGEINFOKEY";
static NSString *const paramLastVersion = @"lastVersion";
static NSString *const paramCurrentVersion = @"currentVersion";
static NSString *const paramIsFirstTime = @"isFirstTime";
static NSString *const paramIsFirstLoadOk = @"isFirstLoadOK";
static NSString *const paramIsRolledBack = @"isRolledBack";

// app info
static NSString * const AppVersionKey = @"appVersion";
static NSString * const BuildVersionKey = @"buildVersion";

// file def
static NSString * const BUNDLE_FILE_NAME = @"index.bundlejs";
static NSString * const SOURCE_PATCH_NAME = @"__diff.json";
static NSString * const BUNDLE_PATCH_NAME = @"index.bundlejs.patch";

// error def
static NSString * const ERROR_OPTIONS = @"options error";
static NSString * const ERROR_BSDIFF = @"bsdiff error";
static NSString * const ERROR_FILE_OPERATION = @"file operation error";

// event def
static NSString * const EVENT_PROGRESS_DOWNLOAD = @"RCTHotUpdateDownloadProgress";
static NSString * const EVENT_PROGRESS_UNZIP = @"RCTHotUpdateUnzipProgress";
static NSString * const PARAM_PROGRESS_RECEIVED = @"received";
static NSString * const PARAM_PROGRESS_TOTAL = @"total";


typedef NS_ENUM(NSInteger, HotUpdateType) {
    HotUpdateTypeFullDownload = 1,
    HotUpdateTypePatchFromPackage = 2,
    HotUpdateTypePatchFromPpk = 3,
};

@implementation RCTHotUpdate {
    RCTHotUpdateManager *_fileManager;
}

@synthesize bridge = _bridge;
@synthesize methodQueue = _methodQueue;

RCT_EXPORT_MODULE(RCTHotUpdate);

+ (NSURL *)bundleURL
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSDictionary *packageInfo = [defaults dictionaryForKey:rnHotUpdatePackageInfoKey];
    
    if (packageInfo) {
        NSString *curVersion = packageInfo[paramCurrentVersion];
        NSString *lastVersion = packageInfo[paramLastVersion];
        
        BOOL isFirstTime = [packageInfo[paramIsFirstTime] boolValue];
        BOOL isFirstLoadOK = [packageInfo[paramIsFirstLoadOk] boolValue];
        
        NSString *loadVersioin = curVersion;
        if ((isFirstTime == NO && isFirstLoadOK == NO) || (loadVersioin.length<=0 && lastVersion.length>0)) {
            loadVersioin = lastVersion;
            
            // roll back to last version
            NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
            if (lastVersion.length) {
                [defaults setObject:@{paramCurrentVersion:lastVersion, paramIsFirstTime:@(NO), paramIsFirstLoadOk:@(YES), paramIsRolledBack:@(YES)} forKey:rnHotUpdatePackageInfoKey];
            }
            else {
                [defaults setObject:@{paramIsRolledBack:@(YES)} forKey:rnHotUpdatePackageInfoKey];
            }
            [defaults setObject:packageInfo forKey:rnHotUpdatePackageInfoKey];
            [defaults synchronize];
        }
        
        if (loadVersioin.length) {
            NSString *downloadDir = [RCTHotUpdate downloadDir];
            
            NSString *bundlePath = [[downloadDir stringByAppendingPathComponent:loadVersioin] stringByAppendingPathComponent:BUNDLE_FILE_NAME];
            if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePath isDirectory:NULL]) {
                NSURL *bundleURL = [NSURL fileURLWithPath:bundlePath];
                return bundleURL;
            }
        }
    }
    
    return [RCTHotUpdate binaryBundleURL];
}

- (NSDictionary *)constantsToExport
{
    NSDictionary *infoDictionary = [[NSBundle mainBundle] infoDictionary];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *packageInfo = [[defaults dictionaryForKey:rnHotUpdatePackageInfoKey] mutableCopy];
    
    NSMutableDictionary *ret = [@{} mutableCopy];
    ret[@"downloadRootDir"] = [RCTHotUpdate downloadDir];
    ret[@"packageVersion"] = [infoDictionary objectForKey:@"CFBundleShortVersionString"];
    ret[@"currentVersion"] = [packageInfo objectForKey:paramCurrentVersion];
    ret[@"isFirstTime"] = [packageInfo objectForKey:paramIsFirstTime];
    ret[@"isRolledBack"] = [packageInfo objectForKey:paramIsRolledBack];
    
    if (packageInfo) {
        // clear isFirstTime and isRolledBack
        packageInfo[paramIsFirstTime] = @(NO);
        packageInfo[paramIsRolledBack] = @(NO);
        [defaults setObject:packageInfo forKey:rnHotUpdatePackageInfoKey];
        [defaults synchronize];
    }
    return ret;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _fileManager = [RCTHotUpdateManager new];
    }
    return self;
}

RCT_EXPORT_METHOD(getVersionInfo:(RCTResponseSenderBlock)callback)
{
    NSDictionary *infoDictionary = [[NSBundle mainBundle] infoDictionary];
    
    NSString *appVersion = [infoDictionary objectForKey:@"CFBundleShortVersionString"];
    NSString *buildVersion = [infoDictionary objectForKey:@"CFBundleVersion"];
    
    NSDictionary *versionInfo = @{AppVersionKey:appVersion, BuildVersionKey:buildVersion};
    if (callback) {
        callback(@[versionInfo]);
    }
}


RCT_EXPORT_METHOD(downloadUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self hotUpdate:HotUpdateTypeFullDownload options:options callback:^(NSError *error) {
        if (error) {
            [self reject:reject error:error];
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(downloadPatchFromPackage:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self hotUpdate:HotUpdateTypePatchFromPackage options:options callback:^(NSError *error) {
        if (error) {
            [self reject:reject error:error];
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(downloadPatchFromPpk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self hotUpdate:HotUpdateTypePatchFromPpk options:options callback:^(NSError *error) {
        if (error) {
            [self reject:reject error:error];
        }
        else {
            resolve(nil);
        }
    }];
}

RCT_EXPORT_METHOD(setNeedUpdate:(NSDictionary *)options)
{
    NSString *hashName = options[@"hashName"];
    if (hashName.length) {
        [self saveCurVersion:hashName];
    }
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options)
{
    NSString *hashName = options[@"hashName"];
    if (hashName.length) {
        [self saveCurVersion:hashName];
        dispatch_async(dispatch_get_main_queue(), ^{
            [_bridge setValue:[[self class] bundleURL] forKey:@"bundleURL"];
            [_bridge reload];
        });
    }
}

RCT_EXPORT_METHOD(markSuccuss)
{
    // update package info
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *packageInfo = [[defaults objectForKey:rnHotUpdatePackageInfoKey] mutableCopy];
    [packageInfo setObject:@(NO) forKey:paramIsFirstTime];
    [packageInfo setObject:@(YES) forKey:paramIsFirstLoadOk];
    [packageInfo setObject:@(NO) forKey:paramIsRolledBack];

    [defaults setObject:packageInfo forKey:rnHotUpdatePackageInfoKey];
    [defaults synchronize];
    
    // clear other package dir
    NSString *downloadDir = [RCTHotUpdate downloadDir];
    NSString *curVersion = [packageInfo objectForKey:paramCurrentVersion];
    
    NSError *error = nil;
    NSArray *list = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:downloadDir error:&error];
    if (error) {
        return;
    }
    
    for(NSString *fileName in list) {
        if (![fileName isEqualToString:curVersion]) {
            [_fileManager removeFile:curVersion completionHandler:nil];
        }
    }
}

#pragma mark - private
- (void)hotUpdate:(HotUpdateType)type options:(NSDictionary *)options callback:(void (^)(NSError *error))callback
{
    NSString *updateUrl = [RCTConvert NSString:options[@"updateUrl"]];
    NSString *hashName = [RCTConvert NSString:options[@"hashName"]];
    if (updateUrl.length<=0 || hashName.length<=0) {
        callback([self errorWithMessage:ERROR_OPTIONS]);
        return;
    }
    NSString *originHashName = [RCTConvert NSString:options[@"originHashName"]];
    if (type == HotUpdateTypePatchFromPpk && originHashName<=0) {
        callback([self errorWithMessage:ERROR_OPTIONS]);
        return;
    }
    
    NSString *dir = [RCTHotUpdate downloadDir];
    BOOL success = [_fileManager createDir:dir];
    if (!success) {
        callback([self errorWithMessage:ERROR_FILE_OPERATION]);
        return;
    }
    
    NSString *zipFilePath = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@%@",hashName, [self zipExtension:type]]];
    NSString *unzipDir = [dir stringByAppendingPathComponent:hashName];

    RCTLogInfo(@"RNUpdate -- download file %@", updateUrl);
    [RCTHotUpdateDownloader download:updateUrl savePath:zipFilePath progressHandler:^(long long receivedBytes, long long totalBytes) {
        [self.bridge.eventDispatcher sendAppEventWithName:EVENT_PROGRESS_DOWNLOAD
                                                     body:@{
                                                            PARAM_PROGRESS_RECEIVED:[NSNumber numberWithLongLong:receivedBytes],
                                                            PARAM_PROGRESS_TOTAL:[NSNumber numberWithLongLong:totalBytes]
                                                            }];
    } completionHandler:^(NSString *path, NSError *error) {
        if (error) {
            callback(error);
        }
        else {
            RCTLogInfo(@"RNUpdate -- unzip file %@", zipFilePath);
            NSString *unzipFilePath = [dir stringByAppendingPathComponent:hashName];
            [_fileManager unzipFileAtPath:zipFilePath toDestination:unzipFilePath progressHandler:^(NSString *entry,long entryNumber, long total) {
                [self.bridge.eventDispatcher sendAppEventWithName:EVENT_PROGRESS_UNZIP
                                                             body:@{
                                                                    PARAM_PROGRESS_RECEIVED:[NSNumber numberWithLong:entryNumber],
                                                                    PARAM_PROGRESS_TOTAL:[NSNumber numberWithLong:total]
                                                                    }];
                
            } completionHandler:^(NSString *path, BOOL succeeded, NSError *error) {
                dispatch_async(_methodQueue, ^{
                    if (error) {
                        callback(error);
                    }
                    else {
                        switch (type) {
                            case HotUpdateTypePatchFromPackage:
                            {
                                NSString *sourceOrigin = [[NSBundle mainBundle] resourcePath];
                                NSString *bundleOrigin = [[RCTHotUpdate binaryBundleURL] path];
                                [self patch:hashName romBundle:bundleOrigin source:sourceOrigin callback:callback];
                            }
                                break;
                            case HotUpdateTypePatchFromPpk:
                            {
                                NSString *lastVertionDir = [dir stringByAppendingPathComponent:originHashName];
                                
                                NSString *sourceOrigin = lastVertionDir;
                                NSString *bundleOrigin = [lastVertionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
                                [self patch:hashName romBundle:bundleOrigin source:sourceOrigin callback:callback];
                            }
                                break;
                            default:
                                callback(nil);
                                break;
                        }
                    }
                });
            }];
        }
    }];
}

- (void)patch:(NSString *)hashName romBundle:(NSString *)bundleOrigin source:(NSString *)sourceOrigin callback:(void (^)(NSError *error))callback
{
    NSString *unzipDir = [[RCTHotUpdate downloadDir] stringByAppendingPathComponent:hashName];
    NSString *sourcePatch = [unzipDir stringByAppendingPathComponent:SOURCE_PATCH_NAME];
    NSString *bundlePatch = [unzipDir stringByAppendingPathComponent:BUNDLE_PATCH_NAME];
    
    NSString *destination = [unzipDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    [_fileManager bsdiffFileAtPath:bundlePatch fromOrigin:bundleOrigin toDestination:destination completionHandler:^(BOOL success) {
        if (success) {
            NSData *data = [NSData dataWithContentsOfFile:sourcePatch];
            NSError *error = nil;
            NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingAllowFragments error:&error];
            if (error) {
                callback(error);
                return;
            }
            NSDictionary *copies = json[@"copies"];
            [_fileManager copyFiles:copies fromDir:sourceOrigin toDir:unzipDir completionHandler:^(NSError *error) {
                if (error) {
                    callback(error);
                }
                else {
                    callback(nil);
                }
            }];
        }
        else {
            callback([self errorWithMessage:ERROR_BSDIFF]);
        }
    }];
}

- (NSString *)zipExtension:(HotUpdateType)type
{
    switch (type) {
        case HotUpdateTypeFullDownload:
            return @".ppk";
        case HotUpdateTypePatchFromPackage:
            return @".apk.patch";
        case HotUpdateTypePatchFromPpk:
            return @".ppk.patch";
        default:
            break;
    }
}

- (void)reject:(RCTPromiseRejectBlock)reject error:(NSError *)error
{
    reject([NSString stringWithFormat: @"%lu", (long)error.code], error.localizedDescription, error);
}

- (void)saveCurVersion:(NSString *)hashCode
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *packageInfo = [[defaults objectForKey:rnHotUpdatePackageInfoKey] mutableCopy];
    if (packageInfo == nil) {
        packageInfo = [@{} mutableCopy];
    }
    packageInfo[paramLastVersion] = packageInfo[paramCurrentVersion];
    packageInfo[paramCurrentVersion] = hashCode;
    packageInfo[paramIsFirstTime] = @(YES);
    packageInfo[paramIsFirstLoadOk] = @(NO);
    packageInfo[paramIsRolledBack] = @(NO);
    
    [defaults setObject:packageInfo forKey:rnHotUpdatePackageInfoKey];
    [defaults synchronize];
}

- (NSError *)errorWithMessage:(NSString *)errorMessage
{
    return [NSError errorWithDomain:@"cn.reactnative.hotupdate"
                               code:-1
                           userInfo:@{ NSLocalizedDescriptionKey: errorMessage}];
}

+ (NSString *)downloadDir
{
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
    NSString *downloadDir = [directory stringByAppendingPathComponent:@"reactnativecnhotupdate"];
    
    return downloadDir;
}

+ (NSURL *)binaryBundleURL
{
    NSURL *url = [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    return url;
}

@end