#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <objbase.h>
#include <shldisp.h>

#include <string>

#include "protocol.h"
#include "toggle_desktop.h"

namespace {

// CLSID_Shell, the "Shell.Application" object implemented by shell32.dll. Spelled out so the
// translation unit needs no GUID library.
constexpr CLSID kClsidShell = {
    0x13709620, 0xc279, 0x11ce, {0xa4, 0x9e, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00}};

}  // namespace

int runToggleDesktop(std::string& out) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  if (FAILED(hr)) {
    out = dhp::serializeError(dhp::ErrorCode::OsError, static_cast<long long>(static_cast<unsigned long>(hr)));
    return 1;
  }
  IShellDispatch4* shell = nullptr;
  hr = CoCreateInstance(kClsidShell, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IShellDispatch4),
                        reinterpret_cast<void**>(&shell));
  if (SUCCEEDED(hr)) {
    hr = shell->ToggleDesktop();
    shell->Release();
  }
  CoUninitialize();  // balances CoInitializeEx for both S_OK and S_FALSE
  if (FAILED(hr)) {
    out = dhp::serializeError(dhp::ErrorCode::OsError, static_cast<long long>(static_cast<unsigned long>(hr)));
    return 1;
  }
  out = dhp::serializeResult("desktopToggled");
  return 0;
}
