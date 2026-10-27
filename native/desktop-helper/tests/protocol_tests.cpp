// Unit tests for the desktop helper's pure protocol layer (no OS calls).
// Build and run: node native/desktop-helper/run.mjs test
#include <cstdio>
#include <string>

#include "../src/protocol.h"

using namespace dhp;

static int g_pass = 0;
static int g_fail = 0;
#define CHECK(cond)                                               \
  do {                                                            \
    if (cond) {                                                   \
      ++g_pass;                                                   \
    } else {                                                      \
      ++g_fail;                                                   \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    }                                                             \
  } while (0)

namespace {

// Parses expecting success and returns the request, reporting CHECK failures on the way.
Request parseOk(const std::string& line) {
  Request r{};
  ErrorCode code = ErrorCode::OsError;
  const bool ok = parseRequest(line, r, code);
  if (!ok) std::printf("  expected success, got code %d: %s\n", static_cast<int>(code), line.c_str());
  CHECK(ok);
  return ok ? r : Request{};
}

bool rejected(const std::string& line, ErrorCode expected) {
  ErrorCode code = ErrorCode::OsError;
  Request r{};
  const bool ok = parseRequest(line, r, code);
  if (ok) {
    std::printf("  expected rejection, parsed fine: %s\n", line.c_str());
    return false;
  }
  if (code != expected) {
    std::printf("  expected code %d, got %d: %s\n", static_cast<int>(expected), static_cast<int>(code), line.c_str());
    return false;
  }
  return true;
}

}  // namespace

int main() {
  {
    Request r{};
    ErrorCode code = ErrorCode::OsError;
    CHECK(parseRequest(R"({"type":"flushComposition"})", r, code));
    CHECK(parseRequest(R"({"type":"styleWindow","hwnd":"42","ownerPid":"123"})", r, code));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"0","ownerPid":"123"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"9223372036854775808","ownerPid":"123"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"42","ownerPid":"4294967296"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"42","ownerPid":"-1"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"1.5","ownerPid":"123"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":42,"ownerPid":"123"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"styleWindow","hwnd":"42","ownerPid":"123","hwnd":"43"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"flushComposition","hwnd":"42"})", ErrorCode::InvalidRequest));
    CHECK(rejected(R"({"type":"showDesktop","ownerPid":"123"})", ErrorCode::InvalidRequest));
  }
  {
    Request r{};
    ErrorCode code = ErrorCode::OsError;
    CHECK(parseRequest(R"({"type":"showDesktop"})", r, code));
    CHECK(rejected(R"({"type":"showDesktop","exePath":"C:\\app.exe"})", ErrorCode::InvalidRequest));
  }
  // accepted requests
  {
    const Request r = parseOk(R"({"type":"showDesktop"})");
    CHECK(r.kind == Request::Kind::ShowDesktop);
  }
  {
    const Request r = parseOk(R"(  {"type":"showDesktop"}  )");  // surrounding whitespace is fine
    CHECK(r.kind == Request::Kind::ShowDesktop);
  }
  {
    const std::string cr = std::string(R"({"type":"showDesktop"})") + '\r';  // CRLF line ending
    CHECK(parseOk(cr).kind == Request::Kind::ShowDesktop);
  }
  {
    const Request r = parseOk(R"({"type":"activate","exePath":"C:\\Program Files\\Example\\Example.exe"})");
    CHECK(r.kind == Request::Kind::Activate);
    CHECK(r.exePathUtf8 == "C:\\Program Files\\Example\\Example.exe");
  }
  {
    const Request r = parseOk(R"({"type":"activate","exePath":"c:/x/y.EXE"})");  // case and separators vary
    CHECK(r.kind == Request::Kind::Activate);
    CHECK(r.exePathUtf8 == "c:/x/y.EXE");
  }
  {
    const Request r = parseOk(R"({"exePath":"C:\\\u4e2d\u6587\\app.exe","type":"activate"})");  // any key order
    CHECK(r.kind == Request::Kind::Activate);
    CHECK(r.exePathUtf8 == "C:\\\xe4\xb8\xad\xe6\x96\x87\\app.exe");  // UTF-8 after JSON decoding
  }
  {
    const Request r = parseOk(R"({"type":"activate","exePath":"C:\\\ud83d\ude00\\app.exe"})");  // surrogate pair
    CHECK(r.exePathUtf8 == "C:\\\xf0\x9f\x98\x80\\app.exe");
  }
  {
    const Request r = parseOk(R"({"type":"activate","exePath":"C:\\a b\\app .exe"})");  // spaces are legal
    CHECK(r.kind == Request::Kind::Activate);
  }
  {
    // Real byte inputs (std::string keeps every byte): astral-plane boundaries are valid.
    const std::string low = "{\"type\":\"activate\",\"exePath\":\"C:\\\\\xf0\x90\x80\x80\\\\app.exe\"}";   // U+10000
    CHECK(parseOk(low).kind == Request::Kind::Activate);
    const std::string high = "{\"type\":\"activate\",\"exePath\":\"C:\\\\\xf4\x8f\xbf\xbf\\\\app.exe\"}";  // U+10FFFF
    CHECK(parseOk(high).kind == Request::Kind::Activate);
    // Scalars above U+10FFFF are malformed UTF-8; the protocol layer itself must reject them.
    const std::string over = "{\"type\":\"activate\",\"exePath\":\"C:\\\\\xf4\x90\x80\x80\\\\app.exe\"}";  // U+110000
    CHECK(rejected(over, ErrorCode::InvalidRequest));
    const std::string f5 = "{\"type\":\"activate\",\"exePath\":\"C:\\\\\xf5\x80\x80\x80\\\\app.exe\"}";    // lead F5
    CHECK(rejected(f5, ErrorCode::InvalidRequest));
    const std::string f7 = "{\"type\":\"activate\",\"exePath\":\"C:\\\\\xf7\xbf\xbf\xbf\\\\app.exe\"}";    // lead F7
    CHECK(rejected(f7, ErrorCode::InvalidRequest));
  }
  {
    // Characters Windows file names allow stay valid.
    const Request r = parseOk(R"({"type":"activate","exePath":"C:\\It's Tom & Jerry\\app .exe"})");
    CHECK(r.kind == Request::Kind::Activate);
  }

  // malformed requests -> invalidRequest
  CHECK(rejected("", ErrorCode::InvalidRequest));                                                     // truncated/empty
  CHECK(rejected("not json", ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":"showDesktop")", ErrorCode::InvalidRequest));                           // truncated
  CHECK(rejected(R"({})", ErrorCode::InvalidRequest));                                                // no type
  CHECK(rejected(R"({"type":"activate"})", ErrorCode::InvalidRequest));                               // no exePath
  CHECK(rejected(R"({"exePath":"C:\\a.exe"})", ErrorCode::InvalidRequest));                           // no type
  CHECK(rejected(R"({"type":"unknown"})", ErrorCode::InvalidRequest));                                // unknown command
  CHECK(rejected(R"({"type":"Activate"})", ErrorCode::InvalidRequest));                               // exact match only
  CHECK(rejected(R"({"type":123})", ErrorCode::InvalidRequest));                                      // non-string value
  CHECK(rejected(R"({"type":true})", ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":null})", ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":{"a":"b"}})", ErrorCode::InvalidRequest));                                // nested object
  CHECK(rejected(R"({"type":["showDesktop"]})", ErrorCode::InvalidRequest));                        // nested array
  CHECK(rejected(R"({"exePath":{"path":"C:\\a.exe"},"type":"activate"})", ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":"showDesktop","type":"showDesktop"})", ErrorCode::InvalidRequest));   // duplicate key
  CHECK(rejected(R"({"type":"showDesktop","exePath":"C:\\a.exe"})", ErrorCode::InvalidRequest));    // extra field
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a.exe","extra":"x"})", ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":"showDesktop"}x)", ErrorCode::InvalidRequest));                         // trailing garbage
  CHECK(parseOk(R"({"type":"showDesktop"} )").kind == Request::Kind::ShowDesktop);            // trailing space is whitespace
  CHECK(rejected(R"({"type":"showDesktop"}{"type":"showDesktop"})", ErrorCode::InvalidRequest));  // two objects
  CHECK(rejected("{type:\"showDesktop\"}", ErrorCode::InvalidRequest));                             // unquoted key
  // Inputs kept out of CHECK: stringifying a raw literal turns \q / \ud800 into invalid
  // escapes inside the macro's normal-string message.
  {
    const std::string badEscape = R"({"type":"a\qb"})";
    CHECK(rejected(badEscape, ErrorCode::InvalidRequest));                                            // bad escape
    const std::string loneHigh = R"({"type":"\ud800"})";
    CHECK(rejected(loneHigh, ErrorCode::InvalidRequest));                                             // lone high surrogate
    const std::string loneLow = R"({"type":"\ud83d"})";
    CHECK(rejected(loneLow, ErrorCode::InvalidRequest));                                              // lone low surrogate
  }
  CHECK(rejected(std::string("{\"type\":\"a\tb\"}"), ErrorCode::InvalidRequest));                     // raw control char in string
  CHECK(rejected(std::string("{\"type\":\"a\nb\"}"), ErrorCode::InvalidRequest));
  CHECK(rejected(R"({"type":"showDesktop",})", ErrorCode::InvalidRequest));                         // trailing comma
  CHECK(rejected(R"({"type" "showDesktop"})", ErrorCode::InvalidRequest));                           // missing colon
  CHECK(rejected(R"({"type":"showDesktop" "x":"y"})", ErrorCode::InvalidRequest));                   // missing comma
  CHECK(rejected("[1]", ErrorCode::InvalidRequest));                                                   // not an object
  CHECK(rejected("\"x\"", ErrorCode::InvalidRequest));
  // invalid UTF-8 in the raw line: 0xFF is never a valid UTF-8 byte
  CHECK(rejected(std::string("{\"type\":\"activate\",\"exePath\":\"C:\\") + '\xff' + "\\a\\app.exe\"}", ErrorCode::InvalidRequest));

  // well-formed but disallowed paths -> invalidPath
  CHECK(rejected(R"({"type":"activate","exePath":""})", ErrorCode::InvalidPath));                      // empty
  CHECK(rejected(R"({"type":"activate","exePath":"Example.exe"})", ErrorCode::InvalidPath));            // relative
  CHECK(rejected(R"({"type":"activate","exePath":"dir\\Example.exe"})", ErrorCode::InvalidPath));       // relative
  CHECK(rejected(R"({"type":"activate","exePath":"\\server\\share\\Example.exe"})", ErrorCode::InvalidPath));   // UNC
  CHECK(rejected(R"({"type":"activate","exePath":"//server/share/Example.exe"})", ErrorCode::InvalidPath));     // UNC form 2
  CHECK(rejected(R"({"type":"activate","exePath":"\\\\?\\C:\\x\\Example.exe"})", ErrorCode::InvalidPath));      // device namespace
  CHECK(rejected(R"({"type":"activate","exePath":"\\\\.\\C:"})", ErrorCode::InvalidPath));              // device namespace
  CHECK(rejected(R"({"type":"activate","exePath":"C:x\\app.exe"})", ErrorCode::InvalidPath));           // drive-relative
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\app.exe:stream"})", ErrorCode::InvalidPath));  // ADS
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x:y\\app.exe"})", ErrorCode::InvalidPath));       // second colon
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\app.dll"})", ErrorCode::InvalidPath));         // not .exe
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\app"})", ErrorCode::InvalidPath));             // no extension
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\app.exe."})", ErrorCode::InvalidPath));        // trailing dot
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\app.exe "})", ErrorCode::InvalidPath));        // trailing space
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\x\\..\\app.exe"})", ErrorCode::InvalidPath));     // parent hop
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\.\\app.exe"})", ErrorCode::InvalidPath));         // current-dir hop
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a<b\\app.exe"})", ErrorCode::InvalidPath));       // forbidden chars
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a>b\\app.exe"})", ErrorCode::InvalidPath));
  {
    const std::string quotedInside = R"({"type":"activate","exePath":"C:\\a\"b\\app.exe"})";  // JSON-escaped quote decodes into the path
    CHECK(rejected(quotedInside, ErrorCode::InvalidPath));                                            // quote inside path
  }
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a|b\\app.exe"})", ErrorCode::InvalidPath));
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a?b\\app.exe"})", ErrorCode::InvalidPath));
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a*b\\app.exe"})", ErrorCode::InvalidPath));
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a\u0000b\\app.exe"})", ErrorCode::InvalidPath));  // embedded NUL
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a\u0001b\\app.exe"})", ErrorCode::InvalidPath));  // control char
  CHECK(rejected(R"({"type":"activate","exePath":"C:\\a\u007fb\\app.exe"})", ErrorCode::InvalidPath));  // DEL
  {
    // JSON needs \\ per backslash: "C:\\" decodes to C:\, so the decoded path is 3 + N + 4 chars.
    const std::string overLimit = R"({"type":"activate","exePath":"C:\\)" + std::string(32800, 'a') + ".exe\"}";
    CHECK(rejected(overLimit, ErrorCode::InvalidPath));                                                // over the path limit
    const std::string atLimit = R"({"type":"activate","exePath":"C:\\)" + std::string(32760, 'a') + ".exe\"}";
    CHECK(parseOk(atLimit).kind == Request::Kind::Activate);                                          // 32767 exactly still fits
  }

  // result serialization
  CHECK(serializeResult("activated") == R"({"type":"result","status":"activated"})");
  CHECK(serializeResult("launchRequired") == R"({"type":"result","status":"launchRequired"})");
  CHECK(serializeResult("activationDenied") == R"({"type":"result","status":"activationDenied"})");
  CHECK(serializeResult("desktopShown") == R"({"type":"result","status":"desktopShown"})");
  CHECK(serializeError(ErrorCode::InvalidRequest) == R"({"type":"result","status":"error","code":"invalidRequest"})");
  CHECK(serializeError(ErrorCode::InvalidPath) == R"({"type":"result","status":"error","code":"invalidPath"})");
  CHECK(serializeError(ErrorCode::OsError) == R"({"type":"result","status":"error","code":"osError"})");
  CHECK(serializeError(ErrorCode::OsError, 5) == R"({"type":"result","status":"error","code":"osError","win32":5})");
  CHECK(serializeError(ErrorCode::OsError, 2147483653) ==
        R"({"type":"result","status":"error","code":"osError","win32":2147483653})");
  CHECK(serializeResult("activated").size() <= kMaxResponseBytes);
  CHECK(serializeError(ErrorCode::OsError, 2147483653).size() <= kMaxResponseBytes);
  CHECK(std::string(errorStatusCode(ErrorCode::OsError)) == "osError");

  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
