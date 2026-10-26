# Test-only synthetic Alt tap, restricted to the foreground GUI fixture owned by the smoke run.
# This is OS-injected input, never a hardware-mouse acceptance result or a production action.
param([Parameter(Mandatory=$true)][uint32]$TargetPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LolPingSmokeInput {
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
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static bool Tap(uint owner) {
    uint actual;
    GetWindowThreadProcessId(GetForegroundWindow(), out actual);
    if (actual != owner) return false;
    foreach (int vk in new int[]{0x10,0x11,0x12,0x5b,0x5c})
      if ((GetAsyncKeyState(vk) & 0x8000) != 0) return false;
    var down = new INPUT { type = 1 };
    down.data.key = new KEY { vk = 0xa4 };
    var up = new INPUT { type = 1 };
    up.data.key = new KEY { vk = 0xa4, flags = 2 };
    return SendInput(2, new INPUT[]{down,up}, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
}
'@
if (-not [LolPingSmokeInput]::Tap($TargetPid)) {
  Write-Output '{"ok":false,"code":"fixtureNotForegroundOrModifiersHeld"}'
  exit 1
}
Write-Output '{"ok":true,"osInjectedAlt":true,"hardwareVerified":false}'
