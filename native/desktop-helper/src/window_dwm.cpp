#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>

#include "protocol.h"
#include "window_dwm.h"

namespace {
int result(HRESULT hr, const char* status, std::string& out) {
  if (FAILED(hr)) {
    out = dhp::serializeError(dhp::ErrorCode::OsError, static_cast<unsigned long>(hr));
    return 1;
  }
  out = dhp::serializeResult(status);
  return 0;
}

bool belongsTo(HWND window, DWORD ownerPid) {
  DWORD actual = 0;
  return IsWindow(window) && GetWindowThreadProcessId(window, &actual) != 0 && actual == ownerPid;
}
}  // namespace

int runFlushComposition(std::string& out) {
  return result(DwmFlush(), "compositionFlushed", out);
}

int runStyleWindow(std::uint64_t hwnd, std::uint32_t ownerPid, std::string& out) {
  const auto window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(hwnd));
  if (!belongsTo(window, ownerPid)) return result(E_ACCESSDENIED, "frameStyled", out);
  const BOOL dark = TRUE;
  const HRESULT hr = DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
  if (!belongsTo(window, ownerPid)) return result(E_ACCESSDENIED, "frameStyled", out);
  return result(hr, "frameStyled", out);
}
