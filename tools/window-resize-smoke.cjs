/*
 * Windows-only native resize A/B check. About 6000 horizontal px/s, six outward/inward cycles.
 * A synthetic backdrop covers the display. Pixel samples stay in memory; output is metadata only.
 * This is injected native mouse input, not evidence of a user's physical gesture.
 */
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync, execFile } = require('node:child_process');
const PROBE = String.raw`param([long]$Handle, [int]$OwnerPid)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
public static class OwnedResizeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flag);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static string Run(long handle, int pid) {
    SetProcessDPIAware(); IntPtr h = new IntPtr(handle); uint owner; GetWindowThreadProcessId(h, out owner);
    if (owner != pid) throw new Exception("ownerMismatch");
    SetForegroundWindow(h);
    int darkFrame;int darkStatus=DwmGetWindowAttribute(h,20,out darkFrame,4);
    Point original; GetCursorPos(out original); int whites=0, samples=0, changed=0, skipped=0,maxWhiteFrame=0;
    int[] depth=new int[60];
    System.Diagnostics.Stopwatch timer=new System.Diagnostics.Stopwatch();
    Rect start; GetWindowRect(h, out start);
    Thread moveThread = null;
    try {
      SetCursorPos(start.R-2, start.B-2); mouse_event(2,0,0,0,UIntPtr.Zero);
      int previousW=start.R-start.L;
      moveThread = new Thread(() => {
        long tick=System.Diagnostics.Stopwatch.GetTimestamp();
        long interval=System.Diagnostics.Stopwatch.Frequency/250;
        for(int step=0;step<240;step++) {
          int phase=step%40;int offset=(phase<=20?phase:40-phase)*24;
          SetCursorPos(start.R-2+offset,start.B-2+offset/2);
          long due=tick+(step+1)*interval;
          while(System.Diagnostics.Stopwatch.GetTimestamp()<due)Thread.SpinWait(64);
        }
      });
      timer.Start();moveThread.Start();
      while(moveThread.IsAlive) {
        int frameWhite=0;
        Rect r; GetWindowRect(h,out r); if(r.R-r.L!=previousW) changed++; previousW=r.R-r.L;
        Rect c; GetClientRect(h,out c); Point p=new Point(); ClientToScreen(h,ref p);
        int[,] regions = { {p.X+c.R-60,p.Y+90,58,140}, {p.X+90,p.Y+c.B-60,140,58} };
        for(int region=0;region<2;region++) {
          Point center=new Point{X=regions[region,0]+25,Y=regions[region,1]+25};
          if(GetAncestor(WindowFromPoint(center),2)!=h){skipped++;continue;}
          using(Bitmap b=new Bitmap(regions[region,2],regions[region,3])) {
            using(Graphics g=Graphics.FromImage(b)) g.CopyFromScreen(regions[region,0],regions[region,1],0,0,b.Size);
            for(int y=0;y<b.Height;y+=2) for(int x=0;x<b.Width;x+=2) {
              Color color=b.GetPixel(x,y); samples++; if(color.R>220&&color.G>220&&color.B>220) {
                whites++;frameWhite++;depth[region==0?b.Width-1-x:b.Height-1-y]++;
              }
            }
          }
        }
        maxWhiteFrame=Math.Max(maxWhiteFrame,frameWhite);
      }
    } finally {if(moveThread!=null)moveThread.Join();timer.Stop();mouse_event(4,0,0,0,UIntPtr.Zero);SetCursorPos(original.X,original.Y);}
    return "{\"nativeDarkFrame\":"+darkFrame+",\"darkStatus\":"+darkStatus+",\"elapsedMs\":"+timer.ElapsedMilliseconds+",\"cursorHorizontalPathPx\":5736,\"samples\":"+samples+",\"whitePixels\":"+whites+",\"changedFrames\":"+changed+",\"skipped\":"+skipped+",\"maxWhiteFrame\":"+maxWhiteFrame+",\"whiteByDepth\":["+String.Join(",",depth)+"]}";
  }
}
'@
[OwnedResizeProbe]::Run($Handle,$OwnerPid)`;

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ nativeResize: 'NOT TESTED', reason: 'WindowsOnly' }));
  } else {
    const root = resolve(__dirname, '..');
    const out = join(root, 'out/window-resize-smoke');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'probe.ps1'), PROBE);
    require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
      platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
    const env = { ...process.env, LOLPING_RESIZE_SMOKE_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require('electron'), [join(out, 'main.cjs'),
      `--user-data-dir=${join(out, `profile-${Date.now()}`)}`],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 90000 });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) console.error(child.error.code || 'launchFailed');
    process.exitCode = child.status ?? 1;
  }
} else {
  const { app, BrowserWindow, screen, session, nativeTheme } = require('electron');
  const { useDarkWindowFrame } = require('../src/main/windowsFrame.ts');
  app.commandLine.appendSwitch('disable-background-networking');
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const root = process.env.LOLPING_RESIZE_SMOKE_ROOT;
    if (!root) throw new Error('launcherRequired');
    let externalRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const external = !details.url.startsWith('data:');
      if (external) externalRequests++;
      callback({ cancel: external });
    });
    // Match production's system theme; never change the user's OS or running app theme.
    nativeTheme.themeSource = 'system';
    const area = screen.getPrimaryDisplay().workArea;
    const backdrop = new BrowserWindow({ ...area, frame: false, show: false, backgroundColor: '#20c060',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let target = null;
    let exitCode = 0;
    const results = [];
    const check = (ok, code) => { if (!ok) throw new Error(code); };
    try {
      backdrop.setAlwaysOnTop(true, 'screen-saver');
      await backdrop.loadURL('data:text/html,<body style="background:%2320c060"></body>');
      backdrop.show();
      for (const mode of ['baseline', 'fixed']) {
        target = new BrowserWindow({ x: area.x + 100, y: area.y + 100, width: 560, height: 600,
          minWidth: 400, minHeight: 360, frame: false, show: false, backgroundColor: '#010a13',
          accentColor: '#53452d', webPreferences: {
            sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        target.setAlwaysOnTop(true, 'screen-saver');
        let nativeResizeEvents = 0;
        target.on('will-resize', () => { nativeResizeEvents++; });
        await target.loadURL('data:text/html,<style>html,body{margin:0;width:100%;height:100%;'
          + 'background:%23010a13;overflow:hidden;color-scheme:dark}</style>');
        if (mode === 'fixed') check(await useDarkWindowFrame(target), 'nativeFrameUnavailable');
        target.show(); target.focus();
        await target.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const handle = target.getNativeWindowHandle().readBigUInt64LE().toString();
        const output = await new Promise((resolveProbe, reject) => execFile(
          join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-File', join(root, 'out/window-resize-smoke/probe.ps1'),
            '-Handle', handle, '-OwnerPid', String(process.pid)],
          { windowsHide: true, timeout: 30000, maxBuffer: 4000 },
          (error, stdout) => error ? reject(new Error('nativeProbeFailed')) : resolveProbe(stdout)));
        const stats = JSON.parse(output);
        const speed = Math.round(stats.cursorHorizontalPathPx * 1000 / stats.elapsedMs);
        results.push({ mode, nativeResizeEvents, speedPxPerSecond: speed, ...stats });
        check(nativeResizeEvents >= 50 && stats.changedFrames >= 20 && stats.samples > 100000, 'nativeResizeNotExercised');
        check(speed >= 5000, 'resizeTooSlow');
        check(stats.skipped < 20, 'fixtureObscured');
        check(mode === 'baseline' ? stats.whitePixels > 0 : stats.whitePixels === 0,
          mode === 'baseline' ? 'baselineNotReproduced' : 'whiteResizeGutter');
        target.destroy(); target = null;
      }
      check(externalRequests === 0, 'unexpectedExternalRequest');
      console.log(JSON.stringify({ nativeResize: 'PASS', systemDarkColors: nativeTheme.shouldUseDarkColors, externalRequests, results }));
    } catch (error) {
      const code = /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(error.message) ? error.message : 'unexpectedResizeFailure';
      console.log(JSON.stringify({ nativeResize: 'FAIL', code, externalRequests, results }));
      exitCode = 1;
    } finally {
      if (target && !target.isDestroyed()) target.destroy();
      backdrop.destroy();
      app.exit(exitCode);
    }
  }).catch(() => { console.log(JSON.stringify({ nativeResize: 'FAIL', code: 'setupFailed' })); app.exit(1); });
}
