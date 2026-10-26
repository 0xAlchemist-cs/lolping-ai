// desktop-helper.exe: one-shot console child of Electron. Reads one flat JSON request line
// from stdin, writes one flat JSON result line to stdout, exits. See
// docs/p3-desktop-helper-contract.md for the protocol this implements.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdio>
#include <string>

#include "activate.h"
#include "protocol.h"
#include "toggle_desktop.h"

namespace {

enum class Read { Ok, Truncated, TooLarge, Trailing };

// Reads up to one LF-terminated line. Rejects requests over kMaxRequestBytes, requests the
// end of input before the LF, and anything after the request line (in the same read or later).
Read readRequestLine(std::string& line) {
  const HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buf[4096];
  DWORD n = 0;
  line.clear();
  bool lf = false;
  bool trailing = false;
  while (!lf) {
    if (!ReadFile(in, buf, sizeof(buf), &n, nullptr) || n == 0) return Read::Truncated;  // EOF before LF
    for (DWORD k = 0; k < n; ++k) {
      if (buf[k] == '\n') {
        lf = true;
        trailing = k + 1 < n;  // the protocol allows no byte after the request's LF
        break;
      }
      line += buf[k];
      if (line.size() > dhp::kMaxRequestBytes) return Read::TooLarge;
    }
  }
  if (trailing) return Read::Trailing;
  if (ReadFile(in, buf, 1, &n, nullptr) && n > 0) return Read::Trailing;
  return Read::Ok;
}

bool writeResult(const std::string& line) {
  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  const std::string buf = line + "\n";
  DWORD written = 0;
  return WriteFile(out, buf.data(), static_cast<DWORD>(buf.size()), &written, nullptr) != 0 && written == buf.size();
}

}  // namespace

int wmain() {
  std::string line;
  std::string result;
  int exitCode = 0;
  switch (readRequestLine(line)) {
    case Read::Ok: {
      dhp::Request req;
      dhp::ErrorCode err = dhp::ErrorCode::InvalidRequest;
      if (!dhp::parseRequest(line, req, err)) {
        result = dhp::serializeError(err);
        exitCode = 1;
      } else if (req.kind == dhp::Request::Kind::Activate) {
        exitCode = runActivate(req.exePathUtf8, result);
      } else {
        exitCode = runToggleDesktop(result);
      }
      break;
    }
    case Read::Truncated:
      std::fprintf(stderr, "[desktop-helper] request truncated\n");
      result = dhp::serializeError(dhp::ErrorCode::InvalidRequest);
      exitCode = 1;
      break;
    case Read::TooLarge:
      std::fprintf(stderr, "[desktop-helper] request over size limit\n");
      result = dhp::serializeError(dhp::ErrorCode::InvalidRequest);
      exitCode = 1;
      break;
    case Read::Trailing:
      std::fprintf(stderr, "[desktop-helper] trailing bytes after request\n");
      result = dhp::serializeError(dhp::ErrorCode::InvalidRequest);
      exitCode = 1;
      break;
  }
  if (result.size() > dhp::kMaxResponseBytes) {  // unreachable with fixed result strings; guards the wire cap
    result = dhp::serializeError(dhp::ErrorCode::InvalidRequest);
    exitCode = 1;
  }
  writeResult(result);
  return exitCode;
}
