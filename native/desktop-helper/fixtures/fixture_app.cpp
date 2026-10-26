// Controlled GUI fixture for desktop-helper end-to-end tests. Never touches unrelated
// applications: it only creates and observes its own windows.
//
// Modes (argv[1]): normal | minimized | multi | hidden | noactivate | hung | vanish
//
// Protocol on stdout (one line each, flushed):
//   ready <pid> <utf8 exe path>   windows are up
//   minimized                     the window minimized itself (minimized mode)
//   activating                    an activation attempt reached the window (vanish mode)
//   gone                          the window destroyed itself (vanish mode)
//   restored                      a window came back from minimized
//   foreground                    one of our windows is the foreground window
//   error <win32 code>            window creation failed (e.g. no interactive desktop)
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdio>
#include <string>

namespace {

const wchar_t* kClass = L"LolPingDesktopHelperFixture";
std::string gMode;
bool gGoneEmitted = false;

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
  for (int i = 0; i < count; ++i) {
    windows[i] = CreateWindowExW(exStyle, kClass, L"lolPing desktop helper fixture",
                                 WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 420, 300,
                                 nullptr, nullptr, wc.hInstance, nullptr);
    if (!windows[i]) {
      emit("error " + std::to_string(GetLastError()));
      return 1;
    }
  }

  wchar_t self[MAX_PATH];
  const DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH);
  emit("ready " + std::to_string(GetCurrentProcessId()) + " " + toUtf8(std::wstring(self, n)));

  bool sawForeground = false;
  bool iconic[2] = {false, false};
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
