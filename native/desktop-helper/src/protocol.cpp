#include "protocol.h"

#include <cstdint>

namespace dhp {
namespace {

bool isWs(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

void skipWs(const std::string& s, size_t& i) {
  while (i < s.size() && isWs(s[i])) ++i;
}

void appendUtf8(uint32_t cp, std::string& out) {
  if (cp < 0x80) {
    out += static_cast<char>(cp);
  } else if (cp < 0x800) {
    out += static_cast<char>(0xC0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xE0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (cp & 0x3F));
  }
}

// Copies one raw UTF-8 sequence at i, rejecting overlong forms, surrogates and truncated
// sequences. Returns the sequence length, or 0 when invalid.
size_t copyRawUtf8(const std::string& s, size_t i, std::string& out) {
  const unsigned char c0 = static_cast<unsigned char>(s[i]);
  if (c0 < 0x80) {
    out += s[i];
    return 1;
  }
  size_t len;
  uint32_t cp;
  if ((c0 & 0xE0) == 0xC0) {
    len = 2;
    cp = c0 & 0x1F;
  } else if ((c0 & 0xF0) == 0xE0) {
    len = 3;
    cp = c0 & 0x0F;
  } else if ((c0 & 0xF8) == 0xF0) {
    len = 4;
    cp = c0 & 0x07;
  } else {
    return 0;
  }
  if (i + len > s.size()) return 0;
  for (size_t k = 1; k < len; ++k) {
    const unsigned char ck = static_cast<unsigned char>(s[i + k]);
    if ((ck & 0xC0) != 0x80) return 0;
    cp = (cp << 6) | (ck & 0x3F);
  }
  if (len == 2 && cp < 0x80) return 0;
  if (len == 3 && cp < 0x800) return 0;
  if (len == 4 && cp < 0x10000) return 0;
  if (cp >= 0xD800 && cp <= 0xDFFF) return 0;  // UTF-8 never encodes surrogates
  if (cp > 0x10FFFF) return 0;                 // nor anything above the Unicode maximum
  out.append(s, i, len);
  return len;
}

// Decodes a JSON string at i (the opening quote) into UTF-8. Rejects raw control characters,
// unknown escapes, lone surrogates and invalid raw UTF-8.
bool readJsonString(const std::string& s, size_t& i, std::string& out) {
  if (i >= s.size() || s[i] != '"') return false;
  ++i;
  while (i < s.size()) {
    const char c = s[i];
    if (c == '"') {
      ++i;
      return true;
    }
    if (static_cast<unsigned char>(c) < 0x20) return false;
    if (c == '\\') {
      ++i;
      if (i >= s.size()) return false;
      const char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp = 0;
          for (int k = 0; k < 4; ++k) {
            if (i >= s.size()) return false;
            const char h = s[i++];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= static_cast<uint32_t>(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= static_cast<uint32_t>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= static_cast<uint32_t>(h - 'A' + 10);
            else return false;
          }
          if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate: the low one must follow
            if (i + 1 >= s.size() || s[i] != '\\' || s[i + 1] != 'u') return false;
            i += 2;
            uint32_t lo = 0;
            for (int k = 0; k < 4; ++k) {
              if (i >= s.size()) return false;
              const char h = s[i++];
              lo <<= 4;
              if (h >= '0' && h <= '9') lo |= static_cast<uint32_t>(h - '0');
              else if (h >= 'a' && h <= 'f') lo |= static_cast<uint32_t>(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') lo |= static_cast<uint32_t>(h - 'A' + 10);
              else return false;
            }
            if (lo < 0xDC00 || lo > 0xDFFF) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            return false;  // lone low surrogate
          }
          appendUtf8(cp, out);
          break;
        }
        default:
          return false;
      }
      continue;
    }
    if (static_cast<unsigned char>(c) < 0x80) {
      out += c;
      ++i;
      continue;
    }
    const size_t n = copyRawUtf8(s, i, out);
    if (n == 0) return false;
    i += n;
  }
  return false;  // ran out of input inside the string
}

// Lexical check for the contract's "local absolute .exe path": drive-rooted, no UNC or device
// namespace (those fail the drive-letter prefix), no second colon (ADS), no relative hop
// components, no characters Windows filenames cannot contain, no control characters, .exe
// extension, and within the 32767-character path limit.
bool isValidLocalExePath(const std::string& p) {
  if (p.size() < 3) return false;
  const char drive = p[0];
  if (!((drive >= 'A' && drive <= 'Z') || (drive >= 'a' && drive <= 'z'))) return false;
  if (p[1] != ':') return false;
  if (p[2] != '\\' && p[2] != '/') return false;
  size_t chars = 0;
  size_t compStart = 3;
  size_t lastSep = 2;  // position of the final separator seen
  for (size_t i = 0; i < p.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(p[i]);
    if ((c & 0xC0) != 0x80) ++chars;  // count code points, not bytes
    if (c < 0x80) {
      if (c < 0x20 || c == 0x7F) return false;
      if (c == '<' || c == '>' || c == '"' || c == '|' || c == '?' || c == '*') return false;
      if (c == ':' && i != 1) return false;
      if (c == '\\' || c == '/') {
        if (i - compStart == 1 && p[compStart] == '.') return false;                        // "." component
        if (i - compStart == 2 && p[compStart] == '.' && p[compStart + 1] == '.') return false;  // ".." component
        compStart = i + 1;
        lastSep = i;
      }
    }
  }
  if (chars > 32767) return false;
  const size_t nameLen = p.size() - lastSep - 1;
  if (nameLen < 4) return false;
  char ext[4] = {p[p.size() - 4], p[p.size() - 3], p[p.size() - 2], p[p.size() - 1]};
  for (char& e : ext)
    if (e >= 'A' && e <= 'Z') e = static_cast<char>(e - 'A' + 'a');
  return ext[0] == '.' && ext[1] == 'e' && ext[2] == 'x' && ext[3] == 'e';
}

}  // namespace

bool parseRequest(const std::string& line, Request& out, ErrorCode& code) {
  code = ErrorCode::InvalidRequest;
  bool hasType = false, hasExePath = false;
  std::string type;
  std::string exePath;
  size_t i = 0;
  skipWs(line, i);
  if (i >= line.size() || line[i] != '{') return false;
  ++i;
  skipWs(line, i);
  if (i < line.size() && line[i] == '}') {
    ++i;
  } else {
    while (true) {
      std::string key;
      skipWs(line, i);
      if (!readJsonString(line, i, key)) return false;
      skipWs(line, i);
      if (i >= line.size() || line[i] != ':') return false;
      ++i;
      skipWs(line, i);
      std::string value;
      if (!readJsonString(line, i, value)) return false;  // non-string values cannot be flat requests
      if (key == "type" && !hasType) {
        hasType = true;
        type = value;
      } else if (key == "exePath" && !hasExePath) {
        hasExePath = true;
        exePath = value;
      } else {
        return false;  // unknown key or a repeat of one
      }
      skipWs(line, i);
      if (i < line.size() && line[i] == ',') {
        ++i;
        continue;
      }
      if (i < line.size() && line[i] == '}') {
        ++i;
        break;
      }
      return false;
    }
  }
  skipWs(line, i);
  if (i != line.size()) return false;  // trailing garbage
  if (!hasType) return false;
  if (type == "showDesktop") {
    if (hasExePath) return false;
    out.kind = Request::Kind::ShowDesktop;
    return true;
  }
  if (type != "activate") return false;
  if (!hasExePath) return false;
  if (!isValidLocalExePath(exePath)) {
    code = ErrorCode::InvalidPath;
    return false;
  }
  out.kind = Request::Kind::Activate;
  out.exePathUtf8 = exePath;
  return true;
}

std::string serializeResult(const char* status) {
  return std::string(R"({"type":"result","status":")") + status + "\"}";
}

const char* errorStatusCode(ErrorCode code) {
  switch (code) {
    case ErrorCode::InvalidRequest: return "invalidRequest";
    case ErrorCode::InvalidPath: return "invalidPath";
    case ErrorCode::OsError: return "osError";
  }
  return "osError";
}

std::string serializeError(ErrorCode code, long long win32) {
  std::string s = std::string(R"({"type":"result","status":"error","code":")") + errorStatusCode(code) + "\"";
  if (win32 >= 0) s += ",\"win32\":" + std::to_string(win32);
  s += "}";
  return s;
}

}  // namespace dhp
