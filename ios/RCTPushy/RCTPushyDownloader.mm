#import "RCTPushyDownloader.h"
#import "RCTPushyCommon.h"
#include "../../cpp/patch_core/archive_limits.h"
#include "../../cpp/patch_core/resume_plan.h"

// Cross-launch resumable download (NATIVE_CHECKUPDATE_DESIGN §11.4): a data
// task streams the archive straight into savePath (a download task's
// temporary file is discarded on failure, which made every partial byte
// worthless), and a sidecar next to it records what the partial belongs to
// (url + validators + total). A brick gets a few hundred milliseconds per
// launch plus a bounded crash-rescue window, so progress must be monotonic
// across process deaths.

NSString *RCTPushyResumeSidecarPath(NSString *savePath) {
    return [savePath stringByAppendingString:@".resume"];
}

// The sidecar's text, "" when there is none or it cannot be one (larger than
// a sidecar ever is): pushy::resume treats both as "no trusted partial".
static NSString *RCTPushyReadSidecarText(NSString *savePath) {
    NSString *path = RCTPushyResumeSidecarPath(savePath);
    NSNumber *size = [[NSFileManager defaultManager] attributesOfItemAtPath:path
                                                                      error:nil][NSFileSize];
    if (size == nil || size.longLongValue > pushy::resume::kMaxSidecarBytes) {
        return @"";
    }
    NSString *text = [NSString stringWithContentsOfFile:path
                                               encoding:NSUTF8StringEncoding
                                                  error:nil];
    return text ?: @"";
}

static std::string RCTPushyStd(NSString *value) {
    const char *utf8 = value.UTF8String;
    return utf8 == nullptr ? std::string() : std::string(utf8);
}

// A pushy::resume result as a dictionary; nil only if it did not parse.
static NSDictionary *RCTPushyResumeDecision(const std::string &json) {
    NSData *data = [NSData dataWithBytes:json.data() length:json.size()];
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

static void RCTPushyDeleteResumeSidecar(NSString *savePath) {
    [[NSFileManager defaultManager] removeItemAtPath:RCTPushyResumeSidecarPath(savePath)
                                               error:nil];
}

void RCTPushyDiscardArchive(NSString *path) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    RCTPushyDeleteResumeSidecar(path);
}

BOOL RCTPushyIsHttpsDowngrade(NSURL *from, NSURL *to) {
    return [[from.scheme lowercaseString] isEqualToString:@"https"]
        && [[to.scheme lowercaseString] isEqualToString:@"http"];
}

long long RCTPushyFileSize(NSString *path) {
    NSDictionary *attributes =
        [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    NSNumber *size = attributes[NSFileSize];
    return size == nil ? -1 : size.longLongValue;
}

// Free space on the volume holding `path` (walks up to an existing ancestor);
// -1 when unknown.
static long long RCTPushyFreeDiskSpaceForPath(NSString *path) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *probe = path;
    while (probe.length > 1 && ![fileManager fileExistsAtPath:probe]) {
        probe = [probe stringByDeletingLastPathComponent];
    }
    NSDictionary *attributes = [fileManager attributesOfFileSystemForPath:probe error:nil];
    NSNumber *free = attributes[NSFileSystemFreeSize];
    return free == nil ? -1 : free.longLongValue;
}

NSString *RCTPushyFreeSpaceShortfall(NSString *path, long long bytesToWrite) {
    long long free = RCTPushyFreeDiskSpaceForPath(path);
    if (free < 0) {
        return nil;
    }
    long long needed = MAX(0LL, bytesToWrite) + pushy::archive_limits::kFreeDiskMarginBytes;
    if (free < needed) {
        return [NSString stringWithFormat:@"insufficient disk space: need %lld bytes, have %lld",
                needed, free];
    }
    return nil;
}

@interface RCTPushyDownloader()<NSURLSessionDataDelegate>

@property (nonatomic, strong) NSURLSession *session;
@property (copy) void (^progressHandler)(long long, long long);
@property (copy) void (^completionHandler)(NSString*, NSError*);
@property (copy) NSString *savePath;
@property (copy) NSString *urlString;
@property (nonatomic, assign) NSTimeInterval timeoutInterval;
@property (nonatomic, strong) NSFileHandle *fileHandle;
// The sidecar the planned request was based on ("" for a fresh request),
// and this response's validators: pushy::resume builds the next sidecar.
@property (nonatomic, copy) NSString *sidecarText;
@property (nonatomic, copy) NSString *responseEtag;
@property (nonatomic, copy) NSString *responseLastModified;
@property (nonatomic, assign) long long resumeOffset;   // requested Range start
@property (nonatomic, assign) long long baseOffset;     // granted by the response
@property (nonatomic, assign) long long receivedBytes;  // streamed this session
@property (nonatomic, assign) long long contentLength;  // this response's body
@property (nonatomic, assign) long long expectedTotal;  // whole file (0 unknown)
@property (nonatomic, strong) NSError *fileError;
@property (nonatomic, assign) BOOL finished;
@property (nonatomic, assign) BOOL retriedFromZero;
// The server encoded the body itself (Content-Encoding other than identity):
// NSURLSession delivers decoded bytes, so length accounting against the
// encoded Content-Length is meaningless and resume offsets cannot be trusted.
@property (nonatomic, assign) BOOL encodedBody;
// The archive was rejected outright (over archive_limits::kMaxArchiveBytes):
// nothing on disk is worth resuming, so completion drops the partial and its
// sidecar instead of leaving them as resume state.
@property (nonatomic, assign) BOOL discardPartial;
@property (nonatomic, assign) int lastReportedPercentage;
@property (nonatomic, assign) long long lastReportedBytes;
// receivedBytes up to which free disk has been probed for (unknown-length
// bodies; 0 = probe before the first write)
@property (nonatomic, assign) long long freeSpaceReservedUntil;
@end

@implementation RCTPushyDownloader

+ (void)download:(NSString *)downloadPath savePath:(NSString *)savePath
timeoutInterval:(NSTimeInterval)timeoutInterval
progressHandler:(void (^)(long long receivedBytes, long long totalBytes))progressHandler
completionHandler:(void (^)(NSString *path, NSError *error))completionHandler
{
    NSAssert(downloadPath, @"no download path");
    NSAssert(savePath, @"no save path");

    RCTPushyDownloader *downloader = [RCTPushyDownloader new];
    downloader.progressHandler = progressHandler;
    downloader.completionHandler = completionHandler;
    downloader.savePath = savePath;
    downloader.urlString = downloadPath;
    downloader.timeoutInterval = timeoutInterval;

    [downloader startTransfer];
}

- (void)startTransfer
{
    NSURL *url = [NSURL URLWithString:self.urlString];
    if (url == nil) {
        [self completeWithError:[NSError errorWithDomain:RCTPushyErrorDomain
                                                    code:-1
                                                userInfo:@{
                                                    NSLocalizedDescriptionKey: @"invalid download url",
                                                }]];
        return;
    }

    // What to request is the shared core's decision (pushy::resume).
    NSString *sidecarText = self.retriedFromZero ? @"" : RCTPushyReadSidecarText(self.savePath);
    long long partialSize = RCTPushyFileSize(self.savePath);
    NSDictionary *plan = RCTPushyResumeDecision(pushy::resume::PlanRequestJson(
        RCTPushyStd(sidecarText), RCTPushyStd(self.urlString), MAX(0LL, partialSize)));
    NSString *action = plan[@"action"];
    self.resumeOffset = 0;
    if ([action isEqualToString:@"complete"]) {
        // Fully received in a previous attempt (the process died between
        // download end and unzip): nothing left to transfer.
        long long knownTotal = [plan[@"total"] longLongValue];
        if (self.progressHandler) {
            self.progressHandler(knownTotal, knownTotal);
        }
        [self completeWithError:nil];
        return;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    if ([action isEqualToString:@"resume"]) {
        self.resumeOffset = [plan[@"offset"] longLongValue];
        self.sidecarText = sidecarText;
        // Range, Accept-Encoding: identity and If-Range. Fresh downloads send
        // none of them and keep the system's transparent gzip handling.
        NSDictionary *headers = plan[@"headers"];
        for (NSString *name in headers) {
            [request setValue:headers[name] forHTTPHeaderField:name];
        }
    } else {
        self.sidecarText = @"";
        RCTPushyDiscardArchive(self.savePath);
    }

    NSURLSessionConfiguration *sessionConfig = [NSURLSessionConfiguration defaultSessionConfiguration];
    // Avoid hanging forever on a stalled connection (default resource timeout
    // is 7 days). The 30s idle timeout matches Android's readTimeout and is
    // what actually catches a stalled transfer; the total-duration cap matches
    // Android's 10min callTimeout — 300s made a 30MB full package on a slow
    // (<100KB/s) network fail on iOS while succeeding on Android.
    sessionConfig.timeoutIntervalForRequest = 30;
    sessionConfig.timeoutIntervalForResource = MAX(1, self.timeoutInterval);
    self.session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                 delegate:self
                                            delegateQueue:nil];

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:request];
    [task resume];
}

- (void)writeSidecarWithTotal:(long long)total
{
    std::string json = pushy::resume::SidecarJson(
        RCTPushyStd(self.urlString), RCTPushyStd(self.responseEtag),
        RCTPushyStd(self.responseLastModified), RCTPushyStd(self.sidecarText), total);
    NSData *data = [NSData dataWithBytes:json.data() length:json.size()];
    // Non-fatal on failure: without a sidecar the next attempt starts from
    // zero.
    [data writeToFile:RCTPushyResumeSidecarPath(self.savePath) atomically:YES];
}

- (void)closeFileHandle
{
    if (self.fileHandle != nil) {
        @try {
            [self.fileHandle closeFile];
        } @catch (NSException *exception) {
        }
        self.fileHandle = nil;
    }
}

- (void)completeWithError:(NSError *)error
{
    if (self.finished) {
        return;
    }
    self.finished = YES;

    [self closeFileHandle];
    if (self.discardPartial) {
        RCTPushyDiscardArchive(self.savePath);
    }

    void (^completionHandler)(NSString *, NSError *) = self.completionHandler;
    self.progressHandler = nil;
    self.completionHandler = nil;
    self.fileError = nil;

    [self.session finishTasksAndInvalidate];
    self.session = nil;

    if (completionHandler) {
        completionHandler(error == nil ? self.savePath : nil, error);
    }
}

- (void)failWithDescription:(NSString *)description code:(NSInteger)code
{
    self.fileError = [NSError errorWithDomain:RCTPushyErrorDomain
                                         code:code
                                     userInfo:@{NSLocalizedDescriptionKey: description}];
}

// Drops the untrusted partial and reissues the whole request from zero, at
// most once per download (the stale-partial 416 case). Delegate callbacks
// from the superseded session are ignored via the session-identity guards.
- (void)restartFromZero
{
    self.retriedFromZero = YES;
    self.sidecarText = @"";
    self.resumeOffset = 0;
    self.baseOffset = 0;
    self.receivedBytes = 0;
    self.contentLength = 0;
    self.expectedTotal = 0;
    self.encodedBody = NO;
    self.lastReportedPercentage = 0;
    self.lastReportedBytes = 0;
    [self closeFileHandle];
    RCTPushyDiscardArchive(self.savePath);
    [self.session finishTasksAndInvalidate];
    self.session = nil;
    [self startTransfer];
}

#pragma mark - session delegate

// An https artifact URL must stay on https through every redirect: the
// package is the supply-chain boundary and TLS is what authenticates it.
// Returning nil delivers the 3xx itself as the response, which the status
// check below then rejects with the recorded reason.
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler
{
    if (session != self.session) {
        completionHandler(nil);
        return;
    }
    if (RCTPushyIsHttpsDowngrade([NSURL URLWithString:self.urlString], request.URL)) {
        [self failWithDescription:[NSString stringWithFormat:
            @"https download redirected to plaintext http: %@", request.URL.absoluteString]
                             code:-1];
        completionHandler(nil);
        return;
    }
    completionHandler(request);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler
{
    if (session != self.session) {
        // A superseded session (restartFromZero) still delivering events.
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    NSHTTPURLResponse *httpResponse =
        [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;
    NSInteger statusCode = httpResponse.statusCode;

    if (self.fileError != nil) {
        // A refused redirect (see willPerformHTTPRedirection) already
        // recorded the real reason; the 3xx being delivered here is not it.
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    // What to do with this response is the shared core's decision
    // (pushy::resume). A non-HTTP response cannot happen for an http(s) URL;
    // it would carry no status, so it is classified like a plain 200.
    NSDictionary *headers = httpResponse.allHeaderFields;
    NSDictionary *decision = RCTPushyResumeDecision(pushy::resume::ClassifyResponseJson(
        httpResponse != nil ? (int)statusCode : 200, self.resumeOffset,
        RCTPushyStd(headers[@"Content-Range"]), RCTPushyStd(headers[@"Content-Encoding"]),
        response.expectedContentLength, RCTPushyStd(self.sidecarText),
        RCTPushyStd(self.urlString), MAX(0LL, RCTPushyFileSize(self.savePath))));
    NSString *action = decision[@"action"];
    if ([action isEqualToString:@"complete"]) {
        // 416 and the partial is actually the complete file.
        long long knownTotal = [decision[@"total"] longLongValue];
        completionHandler(NSURLSessionResponseCancel);
        if (self.progressHandler) {
            self.progressHandler(knownTotal, knownTotal);
        }
        [self completeWithError:nil];
        return;
    }
    if ([action isEqualToString:@"restart"]) {
        // A stale 416, encoded range bytes or a malformed/mismatched
        // Content-Range: the partial cannot be trusted. One clean retry from
        // zero instead of failing terminally, which would keep the partial
        // and hit the same wall on every attempt.
        completionHandler(NSURLSessionResponseCancel);
        if (!self.retriedFromZero) {
            [self restartFromZero];
        } else {
            [self failWithDescription:@"server rejected the download range" code:statusCode];
            [self completeWithError:self.fileError];
        }
        return;
    }
    if (![action isEqualToString:@"write"]) {
        // The partial and its sidecar stay: that is the resume state.
        [self failWithDescription:[NSString stringWithFormat:@"unexpected http status code %ld",
                                   (long)statusCode]
                             code:statusCode];
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }

    BOOL append = [decision[@"append"] boolValue];
    // NSURLSession delivers decoded bytes for an encoded body: the core then
    // reports total 0 (the encoded lengths say nothing about the file).
    self.encodedBody = [decision[@"encoded"] boolValue];
    self.baseOffset = [decision[@"base"] longLongValue];
    self.contentLength = response.expectedContentLength;
    self.expectedTotal = [decision[@"total"] longLongValue];
    id etag = headers[@"ETag"];
    id lastModified = headers[@"Last-Modified"];
    self.responseEtag = [etag isKindOfClass:[NSString class]] ? etag : nil;
    self.responseLastModified = [lastModified isKindOfClass:[NSString class]] ? lastModified : nil;

    // Caps from archive_limits.h, applied before the first body byte lands
    // (Android does the same): the announced size up front here, streamed
    // bytes in didReceiveData as the backstop for unknown/chunked lengths.
    long long announcedTotal = self.expectedTotal;
    if (announcedTotal <= 0 && !self.encodedBody && self.contentLength > 0) {
        // A 206 whose Content-Range total is "*" still announces this body.
        announcedTotal = self.baseOffset + self.contentLength;
    }
    if (announcedTotal > pushy::archive_limits::kMaxArchiveBytes) {
        [self failWithDescription:[NSString stringWithFormat:@"archive too large: %lld bytes",
                                   announcedTotal]
                             code:-1];
        self.discardPartial = YES;
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (!append) {
        // The server ignored the range (or none was sent): the stale partial
        // is dead weight either way, so free it before the space check
        // counts it against this download (a full restart must not fail
        // forever on space the partial itself is holding).
        [fileManager removeItemAtPath:self.savePath error:nil];
    }
    NSString *shortfall = RCTPushyFreeSpaceShortfall(
        self.savePath, announcedTotal > 0 ? announcedTotal - self.baseOffset : 0);
    if (shortfall != nil) {
        // A resumable partial stays: a later attempt may find the space.
        [self failWithDescription:shortfall code:-1];
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    if (!append) {
        [fileManager createFileAtPath:self.savePath contents:nil attributes:nil];
    }
    self.freeSpaceReservedUntil = 0;
    self.fileHandle = [NSFileHandle fileHandleForWritingAtPath:self.savePath];
    if (self.fileHandle == nil) {
        [self failWithDescription:@"cannot open download file for writing" code:-1];
        completionHandler(NSURLSessionResponseCancel);
        [self completeWithError:self.fileError];
        return;
    }
    if (append) {
        @try {
            [self.fileHandle seekToEndOfFile];
        } @catch (NSException *exception) {
            [self failWithDescription:@"cannot seek download file" code:-1];
            completionHandler(NSURLSessionResponseCancel);
            [self completeWithError:self.fileError];
            return;
        }
    }
    if (![decision[@"persistSidecar"] boolValue]) {
        // No resume across an encoded transfer: on-disk bytes are decoded,
        // Range offsets would address the encoded representation.
        RCTPushyDeleteResumeSidecar(self.savePath);
    } else {
        // Persist before streaming so a mid-stream crash can resume.
        [self writeSidecarWithTotal:self.expectedTotal];
    }
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
    if (session != self.session) {
        return;
    }
    if (self.fileHandle == nil || self.fileError != nil) {
        return;
    }
    if (self.baseOffset + self.receivedBytes + (long long)data.length
        > pushy::archive_limits::kMaxArchiveBytes) {
        // Unknown/chunked length backstop; an announced size was already
        // checked in didReceiveResponse. Checked before the write so the
        // file on disk never exceeds the cap.
        [self failWithDescription:[NSString stringWithFormat:
            @"archive too large: exceeded %lld bytes",
            pushy::archive_limits::kMaxArchiveBytes]
                             code:-1];
        self.discardPartial = YES;
        [dataTask cancel];
        return;
    }
    // Unknown/encoded length: the response-time check could only reserve the
    // margin, so the disk is probed before any write that would run past the
    // bytes reserved so far (archive_limits::PlanUnknownLengthFreeSpaceProbe)
    // — no write can ever eat into the margin. The partial stays: a later
    // attempt may find the space.
    pushy::archive_limits::FreeSpaceProbe plan =
        pushy::archive_limits::PlanUnknownLengthFreeSpaceProbe(
            self.expectedTotal, self.receivedBytes, (long long)data.length,
            self.freeSpaceReservedUntil);
    self.freeSpaceReservedUntil = plan.reserved_until;
    if (plan.probe) {
        NSString *shortfall = RCTPushyFreeSpaceShortfall(self.savePath, plan.reserve);
        if (shortfall != nil) {
            [self failWithDescription:shortfall code:-1];
            [dataTask cancel];
            return;
        }
    }
    @try {
        [self.fileHandle writeData:data];
    } @catch (NSException *exception) {
        [self failWithDescription:[NSString stringWithFormat:@"write failed: %@",
                                   exception.reason]
                             code:-1];
        [dataTask cancel];
        return;
    }
    self.receivedBytes += data.length;

    if (!self.progressHandler) {
        return;
    }
    long long overall = self.baseOffset + self.receivedBytes;
    long long total = self.expectedTotal;
    if (overall > total) {
        // Should not happen with identity encoding; treat as unknown so the
        // JS side never sees percentages past 100.
        total = 0;
    }
    if (total > 0) {
        int percentage = (int)((overall * 100.0 / total) + 0.5);
        if (percentage <= self.lastReportedPercentage) {
            return;
        }
        self.lastReportedPercentage = percentage;
    } else {
        // Total unknown: throttle by bytes to avoid flooding the bridge.
        if (overall - self.lastReportedBytes < 256 * 1024) {
            return;
        }
        self.lastReportedBytes = overall;
    }
    self.progressHandler(overall, total);
}

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error
{
    if (session != self.session) {
        // A superseded session (restartFromZero) settling its cancelled
        // task; only the current session may decide this download's fate.
        return;
    }
    if (self.finished) {
        return;
    }
    // The locally recorded failure (e.g. a write error that cancelled the
    // task) is the actual cause; the session error would just say
    // "cancelled".
    NSError *finalError = self.fileError ?: error;
    if (finalError == nil && !self.encodedBody) {
        // Reject truncated transfers like Android/Harmony do. Skipped for
        // encoded bodies: the on-disk size is decoded bytes while the
        // expected lengths count encoded ones.
        if (self.contentLength >= 0 && self.receivedBytes != self.contentLength) {
            [self failWithDescription:[NSString stringWithFormat:
                @"download incomplete: expected %lld bytes, got %lld",
                self.contentLength, self.receivedBytes] code:-1];
            finalError = self.fileError;
        } else if (self.expectedTotal > 0
                   && RCTPushyFileSize(self.savePath) != self.expectedTotal) {
            [self failWithDescription:[NSString stringWithFormat:
                @"download incomplete: expected %lld total bytes, got %lld",
                self.expectedTotal, RCTPushyFileSize(self.savePath)] code:-1];
            finalError = self.fileError;
        }
    }
    if (finalError == nil && !self.encodedBody) {
        // Refresh with the final size: a length unknown up front (chunked)
        // left the sidecar without a total, so a process dying between
        // download end and unzip would otherwise download it all again.
        [self writeSidecarWithTotal:RCTPushyFileSize(self.savePath)];
    }
    // On failure the partial + sidecar stay on disk — that is the resume
    // state a later launch (or crash-rescue window) picks up — unless the
    // archive was rejected outright (discardPartial).
    [self completeWithError:finalError];
}

@end
