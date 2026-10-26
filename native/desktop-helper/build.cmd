@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo vswhere.exe not found. Install Visual Studio 2022 with the "Desktop development with C++" workload.
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
  echo No Visual Studio installation with the C++ x64 tools was found.
  exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build\obj mkdir build\obj
set FLAGS=/nologo /std:c++20 /EHsc /W4 /WX /MT /DUNICODE /D_UNICODE /Fobuild\obj\
cl %FLAGS% /O2 src\main.cpp src\protocol.cpp src\activate.cpp src\toggle_desktop.cpp /Fe:build\desktop-helper.exe /link user32.lib ole32.lib dwmapi.lib || exit /b 1
cl %FLAGS% /Od tests\protocol_tests.cpp src\protocol.cpp /Fe:build\desktop_helper_tests.exe || exit /b 1
cl %FLAGS% /O2 fixtures\fixture_app.cpp /Fe:build\fixture_app.exe /link user32.lib || exit /b 1
echo Built build\desktop-helper.exe, build\desktop_helper_tests.exe and build\fixture_app.exe
