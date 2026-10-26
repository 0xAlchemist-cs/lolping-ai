#pragma once

#include <cstddef>
#include <string>

namespace dhp {

// One validated request. The wire format is a single flat JSON object per process run
// (docs/p3-desktop-helper-contract.md); everything else is rejected before this struct exists.
struct Request {
  enum class Kind { Activate, ToggleDesktop };
  Kind kind;
  std::string exePathUtf8;  // activate only, decoded, otherwise as it appeared on the wire
};

// Wire error codes from the contract.
enum class ErrorCode { InvalidRequest, InvalidPath, OsError };

// Wire limits from the contract: the request line (without LF) and the response line.
constexpr size_t kMaxRequestBytes = 64 * 1024;
constexpr size_t kMaxResponseBytes = 4 * 1024;

// Parses one stdin line (LF stripped). Returns false and sets code when the line is not a
// valid request: malformed JSON, a nested or non-string value, trailing bytes, an unknown or
// missing type, wrong fields, or an exePath that is not a local absolute .exe path.
// Pure: no OS calls, so unit tests can exercise every branch.
bool parseRequest(const std::string& line, Request& out, ErrorCode& code);

// Serializes the four expected results, e.g. {"type":"result","status":"activated"}.
std::string serializeResult(const char* status);

// Serializes an error, appending "win32":<n> when win32 >= 0.
std::string serializeError(ErrorCode code, long long win32 = -1);

/** The wire name of an error code. */
const char* errorStatusCode(ErrorCode code);

}  // namespace dhp
