// Controlled GUI fixture: owns its windows and optionally reports aggregate desktop counts.
// No injected input or shell commands; diagnostic commands never ship in production.
//
// Modes (argv[1]): normal | minimized | multi | hidden | noactivate | hung | vanish
//
// Protocol on stdout (one line each, flushed):
//   ready <pid> <utf8 exe path>   windows are up
//   minimized                     the window minimized itself (minimized mode)
//   activating                    an activation attempt reached the window (vanish mode)
//   gone                          the window destroyed itself (vanish mode)
//   restored                      a window came back from minimized
//   foreground                    one of our windows became the foreground window (one-time)
//   cmd:minimize                  the minimize command ran on the fixture's own window
//   census:...                    aggregate desktop counts (no titles, paths or user content)
//   fg-own=0|1 rejected=N         side-effect-free probe: own window foreground now, and the
//                                 count of rejected (unknown/overlong) commands so far
//   error <win32 code>            window creation failed (e.g. no interactive desktop)
//
// stdin commands: minimize | census | fgown | quit, exact LF/CRLF lines, max 16 bytes.
// Unknown, binary, unterminated and overlong lines never execute; fgown reports rejections.
// Win+D/Alt injection commands were removed; historical comparisons remain in the report.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>

namespace {

const wchar_t* kClass = L"LolPingDesktopHelperFixture";
std::string gMode;
bool gGoneEmitted = false;
HWND gWindows[2] = {};  // the census reports these without enumerating own-process windows

constexpr int kCmdNone = -1, kCmdMinimize = 1, kCmdQuit = 4, kCmdCensus = 5, kCmdFgOwn = 6;
std::atomic<int> gCmd{kCmdNone};
std::atomic<int> gBadCmd{0};  // unknown or overlong commands: counted and reported, never executed

void emit(const std::string& s) {
  std::printf("%s\n", s.c_str());
  std::fflush(stdout);
}

std::string toUtf8(const std::wstring& w) {
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

// A fresh sample avoids treating the historical foreground event as a current condition.
bool ownWindowForeground() {
  const HWND fg = GetForegroundWindow();
  return fg != nullptr && (fg == gWindows[0] || fg == gWindows[1]);
}

// Aggregate desktop census (counts only, no titles or paths): how many ordinary top-level
// windows exist, how many are minimized, and how many visible-but-cloaked (other virtual
// desktops, suspended UWP hosts) are excluded from the ordinary count. This is how the
// diagnostics see the whole desktop state without touching unrelated applications' data.
struct CensusCounts {
  int total = 0;
  int minimized = 0;
  int cloaked = 0;
  int topmost = 0;
  int noActivate = 0;
  int popup = 0;
};
BOOL CALLBACK censusProc(HWND hwnd, LPARAM lp) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == GetCurrentProcessId()) return TRUE;  // the observer must not count itself
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  const DWORD ex = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  if (ex & WS_EX_TOOLWINDOW) return TRUE;
  int cloak = 0;
  // Loaded dynamically: the fixture links only user32, and the build script stays untouched.
  constexpr DWORD kDwmwaCloaked = 13;  // DWMWA_CLOAKED, spelled out for the same reason
  using DwmAttrFn = HRESULT(WINAPI*)(HWND, DWORD, void*, DWORD);
  static const DwmAttrFn dwmAttr = [] {
    const HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
    return dwm ? reinterpret_cast<DwmAttrFn>(GetProcAddress(dwm, "DwmGetWindowAttribute")) : nullptr;
  }();
  if (dwmAttr && SUCCEEDED(dwmAttr(hwnd, kDwmwaCloaked, &cloak, sizeof(cloak))) && cloak != 0) {
    auto* c = reinterpret_cast<CensusCounts*>(lp);
    ++c->cloaked;
    return TRUE;
  }
  auto* c = reinterpret_cast<CensusCounts*>(lp);
  ++c->total;
  if (IsIconic(hwnd)) ++c->minimized;
  const DWORD style = static_cast<DWORD>(GetWindowLongPtrW(hwnd, GWL_STYLE));
  if (ex & WS_EX_TOPMOST) ++c->topmost;
  if (ex & WS_EX_NOACTIVATE) ++c->noActivate;
  if (style & WS_POPUP) ++c->popup;
  return TRUE;
}

void census() {
  CensusCounts c;
  EnumWindows(censusProc, reinterpret_cast<LPARAM>(&c));
  // Shell foreground is only an observation; clicking the desktop can set it too.
  const bool fgIsShell = GetForegroundWindow() != nullptr && GetForegroundWindow() == GetShellWindow();
  const bool ownMinimized = gWindows[0] != nullptr && IsIconic(gWindows[0]);
  emit("census:total=" + std::to_string(c.total) + " minimized=" + std::to_string(c.minimized) +
       " cloaked=" + std::to_string(c.cloaked) + " topmost=" + std::to_string(c.topmost) +
       " noactivate=" + std::to_string(c.noActivate) + " popup=" + std::to_string(c.popup) +
       " fgShell=" + (fgIsShell ? "1" : "0") + " ownMinimized=" + (ownMinimized ? "1" : "0"));
}

// Keep one physical line bounded even when it contains NUL or exceeds a read buffer.
int parseCommand(const std::string& line) {
  if (line == "minimize") return kCmdMinimize;
  if (line == "census") return kCmdCensus;
  if (line == "fgown") return kCmdFgOwn;
  if (line == "quit") return kCmdQuit;
  return kCmdNone;
}

void readCommands() {
  std::string line;
  bool overflow = false;
  int ch;
  while ((ch = std::getchar()) != EOF) {
    if (ch != '\n') {
      if (line.size() < 17) line.push_back(static_cast<char>(ch));
      else overflow = true;
      continue;
    }
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const int cmd = !overflow && line.size() <= 16 ? parseCommand(line) : kCmdNone;
    if (cmd == kCmdNone) ++gBadCmd;
    else gCmd.store(cmd);
    if (cmd == kCmdQuit) return;
    line.clear();
    overflow = false;
  }
  if (!line.empty() || overflow) ++gBadCmd;  // EOF never completes a command.
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_ACTIVATE && gMode == "vanish" && LOWORD(wp) != WA_INACTIVE) {
    // Destroy inside the activation message so the helper's first foreground attempt is
    // already talking to a dead handle; its identity guard must notice on the next check.
    if (!gGoneEmitted) {
      gGoneEmitted = true;
      emit("activating");
      emit("gone");
    }
    DestroyWindow(hwnd);
    return 0;
  }
  if (msg == WM_CLOSE) {
    DestroyWindow(hwnd);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int runMode(const std::string& mode) {
  WNDCLASSW wc{};
  wc.lpfnWndProc = wndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kClass;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  if (!RegisterClassW(&wc)) {
    emit("error " + std::to_string(GetLastError()));
    return 1;
  }

  const int count = mode == "multi" ? 2 : 1;
  const DWORD exStyle = mode == "noactivate" ? WS_EX_NOACTIVATE : 0;
  HWND windows[2] = {};
  gWindows[0] = gWindows[1] = nullptr;
  for (int i = 0; i < count; ++i) {
    windows[i] = CreateWindowExW(exStyle, kClass, L"lolPing desktop helper fixture",
                                 WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 420, 300,
                                 nullptr, nullptr, wc.hInstance, nullptr);
    if (!windows[i]) {
      emit("error " + std::to_string(GetLastError()));
      return 1;
    }
    gWindows[i] = windows[i];
  }

  wchar_t self[MAX_PATH];
  const DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH);
  emit("ready " + std::to_string(GetCurrentProcessId()) + " " + toUtf8(std::wstring(self, n)));

  bool sawForeground = false;
  bool iconic[2] = {false, false};
  std::thread(readCommands).detach();
  if (mode == "hidden") {
    // Created but never shown: like a tray-only application, there is nothing to activate.
  } else if (mode == "hung") {
    ShowWindow(windows[0], SW_SHOW);
    UpdateWindow(windows[0]);
    emit("hung");  // stop pumping: the helper must still return promptly
    Sleep(120000);
    return 0;
  } else {
    for (int i = 0; i < count; ++i) {
      // SHOWNOACTIVATE keeps vanish from being activated by the system before the helper
      // asks for it; for the other modes a plain show is fine.
      ShowWindow(windows[i], mode == "vanish" ? SW_SHOWNOACTIVATE : SW_SHOW);
    }
    if (mode == "minimized") {
      ShowWindow(windows[0], SW_MINIMIZE);
      iconic[0] = IsIconic(windows[0]) != 0;  // captured before the announcement so the harness cannot race it
      emit("minimized");
    }
  }
  const ULONGLONG deadline = GetTickCount64() + 120000;  // safety exit: never outlive a dead harness
  while (GetTickCount64() < deadline) {
    for (int i = 0; i < count; ++i) {
      if (!iconic[i] && IsIconic(windows[i])) {
        iconic[i] = true;
        emit("minimized");  // any cause, including the shell's show-desktop toggle
      } else if (iconic[i] && !IsIconic(windows[i])) {
        iconic[i] = false;
        emit("restored");
      }
    }
    if (!sawForeground) {
      for (int i = 0; i < count; ++i) {
        if (windows[i] && GetAncestor(GetForegroundWindow(), GA_ROOT) == windows[i]) {
          sawForeground = true;
          emit("foreground");
          break;
        }
      }
    }
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) return 0;
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    switch (gCmd.exchange(kCmdNone)) {
      case kCmdMinimize:
        if (windows[0]) ShowWindow(windows[0], SW_MINIMIZE);
        emit("cmd:minimize");
        break;
      case kCmdCensus:
        census();  // aggregate counts only
        break;
      case kCmdFgOwn: {
        // Re-checkable foreground probe with no side effects: is OUR window foreground now?
        // Unlike the one-time "foreground" event, this can be sampled right before each
        // comparison instead of assuming the state persisted.
        emit(std::string("fg-own=") + (ownWindowForeground() ? "1" : "0") +
             " rejected=" + std::to_string(gBadCmd.load()));
        break;
      }
      case kCmdQuit:
        return 0;
      default:
        break;
    }
    MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT);
  }
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  const std::string mode = argc > 1 ? toUtf8(argv[1]) : "normal";
  if (mode != "normal" && mode != "minimized" && mode != "multi" && mode != "hidden" &&
      mode != "noactivate" && mode != "hung" && mode != "vanish") {
    emit("error 87");  // ERROR_INVALID_PARAMETER
    return 1;
  }
  gMode = mode;
  return runMode(mode);
}
