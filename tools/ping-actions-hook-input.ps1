# Test-only input, guarded by the exact foreground window and PID owned by the smoke run.
param(
  [Parameter(Mandatory=$true)][long]$WindowHandle,
  [Parameter(Mandatory=$true)][uint32]$OwnerPid,
  [ValidateSet('alt','ctrl','shift','mouse4','mouse5','none')][string]$Trigger = 'alt',
  [ValidateSet('right','left','center','escape','rightCancel','click')][string]$Mode = 'right',
  [ValidateRange(100,600)][int]$Distance = 200,
  [string]$DriverAssembly = ''
)
$ErrorActionPreference = 'Stop'
$definition = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class LolPingHookInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION {
    [FieldOffset(0)] public MOUSE mouse;
    [FieldOffset(0)] public KEY key;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSE {
    public int x,y; public uint mouseData,flags,time; public IntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEY {
    public ushort vk,scan; public uint flags,time; public IntPtr extra;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flag);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static bool Owner(IntPtr h, uint pid) {
    uint actual; return GetWindowThreadProcessId(h, out actual) != 0 && actual == pid;
  }
  static void Key(ushort vk, bool up) {
    var input = new INPUT { type = 1 };
    input.data.key = new KEY { vk = vk, flags = up ? 2u : 0u };
    Send(input);
  }
  static void Button(bool down, uint side) {
    var input = new INPUT { type = 0 };
    input.data.mouse = new MOUSE { flags = side == 0 ? (down ? 2u : 4u) : (down ? 0x80u : 0x100u), mouseData = side };
    Send(input);
  }
  static void Right(bool down) {
    var input = new INPUT { type = 0 };
    input.data.mouse = new MOUSE { flags = down ? 8u : 16u };
    Send(input);
  }
  static void Send(INPUT input) {
    if (SendInput(1, new INPUT[]{input}, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("inputRejected");
  }
  static void Move(POINT p) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (width < 2 || height < 2) throw new Exception("virtualScreenUnavailable");
    var input = new INPUT { type = 0 };
    input.data.mouse = new MOUSE { x = (int)Math.Round((p.x - left) * 65535.0 / (width - 1)),
      y = (int)Math.Round((p.y - top) * 65535.0 / (height - 1)), flags = 0x8000u | 0x4000u | 0x2000u | 1u };
    Send(input);
    var deadline = Stopwatch.StartNew(); POINT actual;
    while (deadline.ElapsedMilliseconds < 500) {
      if (GetCursorPos(out actual) && actual.x == p.x && actual.y == p.y) return;
      Thread.Yield();
    }
    GetCursorPos(out actual);
    throw new Exception("cursorMoveNotObserved:" + (actual.x - p.x) + "," + (actual.y - p.y));
  }
  public static void Run(long handle, uint pid, string trigger, string mode, int distance) {
    Console.WriteLine("{\"stage\":\"ready\"}"); Console.Out.Flush();
    var startPermission = Console.In.ReadLineAsync();
    if (!startPermission.Wait(4000) || startPermission.Result != "start") throw new Exception("parentStartMissing");
    SetProcessDPIAware();
    var h = new IntPtr(handle);
    if (!Owner(h, pid)) throw new Exception("fixtureOwnerChanged");
    var idle = Stopwatch.StartNew();
    int heldVk;
    do {
      heldVk = 0;
      foreach (int vk in new int[]{1,2,4,5,6,0x10,0x11,0x12,0x5b,0x5c})
        if ((GetAsyncKeyState(vk) & 0x8000) != 0) { heldVk = vk; break; }
      if (heldVk == 0) break;
      Thread.Yield();
    } while (idle.ElapsedMilliseconds < 1000);
    if (heldVk != 0) throw new Exception("userInputHeld:" + heldVk);
    RECT rect; POINT top = new POINT(); POINT original;
    if (!GetClientRect(h, out rect) || !ClientToScreen(h, ref top) || !GetCursorPos(out original)) throw new Exception("geometryUnavailable");
    int width = rect.r - rect.l, height = rect.b - rect.t;
    if (width < distance * 2 + 80 || height < 160) throw new Exception("fixtureTooSmall");
    POINT start = new POINT { x = top.x + width / 2, y = top.y + height / 2 };
    POINT end = new POINT { x = start.x + (mode == "left" ? -distance : distance), y = start.y };
    ushort key = trigger == "alt" ? (ushort)0xa4 : trigger == "ctrl" ? (ushort)0xa2 : trigger == "shift" ? (ushort)0xa0 : (ushort)0;
    uint side = trigger == "mouse4" ? 1u : trigger == "mouse5" ? 2u : 0u;
    bool keyDown = false, buttonDown = false;
    try {
      Move(start);
      // Chromium's child surface can belong to a renderer PID; bind it to our exact root HWND.
      var firstRoot = GetAncestor(WindowFromPoint(start), 2);
      var lastRoot = GetAncestor(WindowFromPoint(end), 2);
      if (firstRoot != h || lastRoot != h) {
        uint firstPid, lastPid;
        GetWindowThreadProcessId(firstRoot, out firstPid); GetWindowThreadProcessId(lastRoot, out lastPid);
        Console.WriteLine("{\"stage\":\"surfaceGuard\",\"startRoot\":" + firstRoot.ToInt64() + ",\"endRoot\":" + lastRoot.ToInt64()
          + ",\"startOwned\":" + (firstPid == pid ? "true" : "false") + ",\"endOwned\":" + (lastPid == pid ? "true" : "false")
          + ",\"startX\":" + start.x + ",\"startY\":" + start.y + ",\"width\":" + width + ",\"height\":" + height + "}");
        Console.Out.Flush();
        throw new Exception("ownedSurfaceUnavailable");
      }
      bool activationClick = GetForegroundWindow() != h;
      if (activationClick) {
        // This point was checked against our exact root HWND; it is an empty area in the controlled fixture.
        Button(true, 0); buttonDown = true;
        Button(false, 0); buttonDown = false;
        var activation = Stopwatch.StartNew();
        while (GetForegroundWindow() != h && activation.ElapsedMilliseconds < 1000) Thread.Yield();
      }
      if (GetForegroundWindow() != h || !Owner(h, pid)) throw new Exception("fixtureActivationDenied");
      Console.WriteLine("{\"stage\":\"armed\",\"activationClick\":" + (activationClick ? "true" : "false") + "}"); Console.Out.Flush();
      var press = Console.In.ReadLineAsync();
      if (!press.Wait(4000) || press.Result != "press") throw new Exception("parentPressMissing");
      if (GetForegroundWindow() != h || !Owner(h, pid)) throw new Exception("fixtureLostFocusBeforeInput");
      if (key != 0) {
        Key(key, false); keyDown = true;
        var deadline = Stopwatch.StartNew();
        while ((GetAsyncKeyState(key) & 0x8000) == 0 && deadline.ElapsedMilliseconds < 500) Thread.Yield();
        if ((GetAsyncKeyState(key) & 0x8000) == 0) throw new Exception("triggerStateUnavailable");
      }
      Button(true, side); buttonDown = true;
      if (mode != "click") Move(end);
      Console.WriteLine("{\"stage\":\"held\"}"); Console.Out.Flush();
      var release = Console.In.ReadLineAsync();
      if (!release.Wait(4000) || release.Result != "release") throw new Exception("parentReleaseMissing");
      if (GetForegroundWindow() != h || !Owner(h, pid)) throw new Exception("fixtureLostFocus");
      if (mode == "center") Move(start);
      if (mode == "escape") { Key(0x1b, false); Key(0x1b, true); }
      if (mode == "rightCancel") { Right(true); Right(false); }
    } finally {
      if (buttonDown) Button(false, side);
      if (keyDown) Key(key, true);
      Console.WriteLine("{\"stage\":\"released\",\"osInjected\":true}"); Console.Out.Flush();
      var restore = Console.In.ReadLineAsync();
      if (restore.Wait(4000) && restore.Result == "restore" && GetForegroundWindow() == h) Move(original);
    }
  }
}
'@
if ($DriverAssembly) {
  if (-not (Test-Path -LiteralPath $DriverAssembly -PathType Leaf)) {
    Add-Type -TypeDefinition $definition -OutputAssembly $DriverAssembly
  }
  Add-Type -Path $DriverAssembly
} else {
  Add-Type -TypeDefinition $definition
}
try {
  [LolPingHookInput]::Run($WindowHandle, $OwnerPid, $Trigger, $Mode, $Distance)
} catch {
  $failure = $_.Exception
  if ($failure.InnerException) { $failure = $failure.InnerException }
  @{stage='error'; code=$failure.Message} | ConvertTo-Json -Compress | Write-Output
  exit 1
}
