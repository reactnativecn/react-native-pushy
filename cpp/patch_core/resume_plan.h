#pragma once

#include <string>

// Cross-launch resumable download (NATIVE_CHECKUPDATE_DESIGN §11.4): the pure
// decisions every platform's downloader makes around a partial archive and
// its `<archive>.resume` sidecar, one implementation for Android
// (DownloadTask.java, through JNI), iOS (RCTPushyDownloader.mm) and Harmony
// (DownloadTask.ts, through NAPI). The downloaders keep the IO: reading and
// writing the archive and the sidecar, the HTTP request, the single retry
// from zero, progress and limits. tests/resume-plan-vectors.json pins this
// layer.
//
// The sidecar records what a partial belongs to:
//   {"url": "...", "etag": "...", "lastModified": "...", "total": N}
// (url always; the validators when the server sent them; total only when
// known). A partial without a sidecar for the same URL is untrusted.
//
// JSON strings in and out, so the bindings stay thin. Keep the core internal
// to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace resume {

// A sidecar is a few hundred bytes; anything larger is not one.
constexpr long long kMaxSidecarBytes = 64 * 1024;

// "bytes <start>-<end>/<total>" (RFC 9110 §14.4), whitespace around the
// numbers allowed, digits only. Returns the total (0 when "*"), or -1 when the
// header is missing or malformed, the start is not expected_start, or the
// range and total contradict each other (end before start, a numeric total
// not beyond end): the appended bytes could not be trusted. A total of 0
// would otherwise pass as "unknown" and skip the final size check.
long long ParseContentRangeTotal(const std::string& header,
                                 long long expected_start);

// What to do before the request, from the sidecar text ("" when there is
// none) and the size of the partial on disk (0 when there is none):
//   {"action":"complete","total":N}  the partial is the whole archive (the
//       process died between download end and unzip): nothing to transfer.
//   {"action":"resume","offset":N,"headers":{...}}  send these headers:
//       Range, Accept-Encoding: identity (offsets must address the bytes on
//       disk) and, when the sidecar has a validator, If-Range (a changed file
//       then comes back as a full 200 instead of mismatched bytes).
//   {"action":"fresh"}  discard the partial and its sidecar; send a plain
//       request (fresh downloads keep the platform's transparent encoding).
std::string PlanRequestJson(const std::string& sidecar, const std::string& url,
                            long long partial_size);

// What to do with the response to a request PlanRequestJson planned
// (resume_offset is its offset, 0 for a fresh request; partial_size the
// partial's size now; content_length the body's, -1 when unknown):
//   {"action":"complete","total":N}  416 and the partial is the whole archive.
//   {"action":"restart"}  the partial is stale (416, an encoded range body, a
//       missing or mismatched Content-Range): discard it and its sidecar and
//       retry once from zero.
//   {"action":"httpError"}  any other non-2xx status: keep the partial and
//       its sidecar (the resume state) and fail.
//   {"action":"write","append":B,"base":N,"total":N,"encoded":B,
//    "persistSidecar":B}  stream the body: appended at base (append) or
//       replacing the partial (base 0); total is the whole archive (0 when
//       unknown or the body is encoded). Persist the sidecar before the first
//       byte lands unless the body is encoded (no resume across an encoded
//       transfer: offsets would address the encoded representation), in
//       which case delete it.
std::string ClassifyResponseJson(int status, long long resume_offset,
                                 const std::string& content_range,
                                 const std::string& content_encoding,
                                 long long content_length,
                                 const std::string& sidecar,
                                 const std::string& url,
                                 long long partial_size);

// The sidecar text for url: this response's validators, falling back to the
// previous sidecar's (same url only) when the response omits them, and total
// when it is known (> 0). Downloaders write it before streaming and once more
// with the final size after a complete, unencoded transfer, so a process
// that dies between download end and unzip finds the archive complete even
// when the length was unknown up front.
std::string SidecarJson(const std::string& url, const std::string& etag,
                        const std::string& last_modified,
                        const std::string& previous_sidecar, long long total);

}  // namespace resume
}  // namespace pushy

#pragma GCC visibility pop
