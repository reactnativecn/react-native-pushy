//
//  RCTHotUpdateDownloader.m
//  RCTHotUpdate
//
//  Created by lvbingru on 16/2/23.
//  Copyright © 2016年 erica. All rights reserved.
//

#import "RCTHotUpdateDownloader.h"

@interface RCTHotUpdateDownloader()<NSURLSessionDelegate>

@property (copy) void (^progressHandler)(long long, long long);
@property (copy) void (^completionHandler)(NSString*, NSError*);
@property (copy) NSString *savePath;
@end

@implementation RCTHotUpdateDownloader

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
progressHandler:(void (^)(long long receivedBytes, long long totalBytes))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler
{
    NSAssert(downloadPath, @"no download path");
    NSAssert(savePath, @"no save path");

    RCTHotUpdateDownloader *downloader = [RCTHotUpdateDownloader new];
    downloader.progressHandler = progressHandler;
    downloader.completionHandler = completionHandler;
    downloader.savePath = savePath;

    [downloader download:downloadPath];
}

- (void)dealloc
{
}

- (void)download:(NSString *)path
{
    NSURL *url = [NSURL URLWithString:path];
    
    NSURLSessionConfiguration *sessionConfig = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                          delegate:self
                                                     delegateQueue:nil];
    
    NSURLSessionDownloadTask *task = [session downloadTaskWithURL:url];
    [session downloadTaskWithURL:url];
    [task resume];
}

#pragma mark - session delegate

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask
      didWriteData:(int64_t)bytesWritten
 totalBytesWritten:(int64_t)totalBytesWritten
totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite
{
#ifdef DEBUG
    NSLog(@"download progress, %lld, %lld, %lld", bytesWritten, totalBytesWritten, totalBytesExpectedToWrite);
#endif
    
    if (self.progressHandler) {
        self.progressHandler(totalBytesWritten ,totalBytesExpectedToWrite);
    }
}

- (void)URLSession:(NSURLSession *)session downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location
{
    NSData *data = [NSData dataWithContentsOfURL:location];
    NSError *error;
    [data writeToFile:self.savePath options:NSDataWritingAtomic error:&error];
    if (error) {
        if (self.completionHandler) {
            self.completionHandler(nil, error);
            self.completionHandler = nil;
        }
    }
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
    if (self.completionHandler) {
        self.completionHandler(self.savePath, error);
    }
}

@end
