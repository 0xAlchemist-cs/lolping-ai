#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <dwmapi.h>

#include <string>

#include "activate.h"
#include "protocol.h"

namespace {

// Strict UTF-8 to UTF-16; the protocol layer already validated the bytes.
std::wstring toWide(const std::string& utf8) {
  if (utf8.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  if (n <= 0) return {};
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), w.data(), n);
  return w;
}

// Normalizes separators only: one kind, no doubles. Case is handled at comparison time.
std::wstring normalizePath(const std::wstring& p) {
  std::wstring k;
  k.reserve(p.size());
  for (wchar_t c : p) {
    if (c == L'/') c = L'\\';
    if (c == L'\\' && !k.empty() && k.back() == L'\\') continue;
    k += c;
  }
  return k;
}

// Ordinal, locale-independent, Unicode case-insensitive comparison of complete UTF-16 paths,
// so a request may differ in case from QueryFullProcessImageNameW output anywhere, not only
// in ASCII.
bool pathsEqual(const std::wstring& a, const std::wstring& b) {
  return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL;
}

// Cloaked windows are not on the current virtual desktop (or are suspended UWP hosts).
bool isCloaked(HWND hwnd) {
  int cloaked = 0;
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked)))) return false;
  return cloaked != 0;
}

// An ordinary main window the helper may activate: visible (minimized counts), unowned, and
// not a tool window, no-activate window or cloaked window.
bool isEligible(HWND hwnd) {
  if (!IsWindowVisible(hwnd)) return false;
  if (GetWindow(hwnd, GW_OWNER) != nullptr) return false;
  const DWORD ex = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  if (ex & WS_EX_TOOLWINDOW) return false;
  if (ex & WS_EX_NOACTIVATE) return false;
  return !isCloaked(hwnd);
}

bool queryImagePath(DWORD pid, std::wstring& out) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return false;  // e.g. a protected process: cannot prove a match
  wchar_t image[32768];
  DWORD size = 32768;
  const bool ok = QueryFullProcessImageNameW(proc, 0, image, &size) != 0;
  CloseHandle(proc);
  if (ok) out.assign(image, size);
  return ok;
}

struct EnumState {
  const std::wstring* key;
  HWND hwnd;
  DWORD pid;
};

// EnumWindows hands top-level windows over in Z order; stop at the first eligible window of
// the exact process image path.
BOOL CALLBACK enumProc(HWND hwnd, LPARAM lp) {
  auto* st = reinterpret_cast<EnumState*>(lp);
  if (!isEligible(hwnd)) return TRUE;
  DWORD pid = 0;
  if (GetWindowThreadProcessId(hwnd, &pid) == 0 || pid == 0) return TRUE;
  std::wstring image;
  if (!queryImagePath(pid, image) || !pathsEqual(normalizePath(image), *st->key)) return TRUE;
  st->hwnd = hwnd;
  st->pid = pid;
  return FALSE;
}

// The selected handle can be destroyed or recycled at any time. Every use re-checks that the
// handle is still a window of the selected process with the expected complete image path
// before the helper touches it, so a recycled handle never receives activation.
bool selectionStillValid(HWND hwnd, DWORD pid, const std::wstring& key) {
  if (!IsWindow(hwnd) || !isEligible(hwnd)) return false;
  DWORD now = 0;
  if (GetWindowThreadProcessId(hwnd, &now) == 0 || now != pid) return false;
  std::wstring image;
  return queryImagePath(pid, image) && pathsEqual(normalizePath(image), key);
}

// Requests restore (if minimized) and foreground activation, retrying briefly while the
// restore settles. Identity is re-verified before the restore and before every attempt.
// Bounded: never waits on the target's UI thread.
bool activateWindow(HWND hwnd, DWORD pid, const std::wstring& key) {
  if (!selectionStillValid(hwnd, pid, key)) return false;
  if (IsIconic(hwnd)) ShowWindowAsync(hwnd, SW_RESTORE);
  const ULONGLONG deadline = GetTickCount64() + 1500;
  while (GetTickCount64() < deadline) {
    if (!selectionStillValid(hwnd, pid, key)) return false;  // destroyed, recycled or re-styled
    SetForegroundWindow(hwnd);  // may be refused; what matters is the verified state below
    if (GetForegroundWindow() == hwnd) return true;
    Sleep(30);
  }
  return false;
}

}  // namespace

int runActivate(const std::string& exePathUtf8, std::string& out) {
  const std::wstring requestPath = toWide(exePathUtf8);
  if (requestPath.size() < 4) {  // the request was validated; a decode that still fails cannot match anything
    out = dhp::serializeError(dhp::ErrorCode::InvalidPath);
    return 1;
  }
  const std::wstring key = normalizePath(requestPath);
  EnumState st{&key, nullptr, 0};
  EnumWindows(enumProc, reinterpret_cast<LPARAM>(&st));
  if (st.hwnd == nullptr) {
    out = dhp::serializeResult("launchRequired");  // includes tray-only applications
    return 0;
  }
  // Once a match is selected the answer is activated or activationDenied, never launchRequired.
  if (!activateWindow(st.hwnd, st.pid, key)) {
    if (selectionStillValid(st.hwnd, st.pid, key)) {
      FLASHWINFO flash{sizeof(FLASHWINFO), st.hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 3, 0};
      FlashWindowEx(&flash);  // attention fallback: visible, but not success
    }
    out = dhp::serializeResult("activationDenied");
    return 0;
  }
  out = dhp::serializeResult("activated");
  return 0;
}
