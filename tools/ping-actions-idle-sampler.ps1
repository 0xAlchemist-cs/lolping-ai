# Test-only sampler. The launcher supplies only its own Electron/helper process IDs.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdleInputClock {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint size; public uint tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint Read() {
    var info = new LASTINPUTINFO { size = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
    if (!GetLastInputInfo(ref info)) throw new InvalidOperationException("lastInputUnavailable");
    return info.tick;
  }
  public static uint Age(uint tick) { return unchecked((uint)Environment.TickCount - tick); }
}
'@
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json $line
  $rows = @()
  foreach ($taskPid in $request.pids) {
    $taskProcess = [Diagnostics.Process]::GetProcessById([int]$taskPid)
    try {
      $taskProcess.Refresh()
      $rows += [pscustomobject]@{
        pid = $taskProcess.Id
        started = $taskProcess.StartTime.ToUniversalTime().Ticks.ToString()
        cpuMs = $taskProcess.TotalProcessorTime.TotalMilliseconds
        workingBytes = $taskProcess.WorkingSet64
        privateBytes = $taskProcess.PrivateMemorySize64
      }
    } finally { $taskProcess.Dispose() }
  }
  $lastInput = [IdleInputClock]::Read()
  [Console]::WriteLine((ConvertTo-Json -Depth 4 -Compress -InputObject ([pscustomobject]@{
    elapsedMs = $clock.Elapsed.TotalMilliseconds
    lastInputTick = $lastInput
    inputAgeMs = [IdleInputClock]::Age($lastInput)
    logicalProcessors = [Environment]::ProcessorCount
    processes = $rows
  })))
}
