/* Actual Fluent inputs and useAppState, synthetic settings and explicitly released IPC replies; no real key/config. */
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/settings-input-smoke');
  mkdirSync(out, { recursive: true });
  const fixture = `import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { AiConfigSection } from '../../src/renderer/settings/components/AiConfigSection';
import { useAppState } from '../../src/renderer/settings/useAppState';
import '../../src/renderer/settings/settings.css';
function Fixture() { const {settings,update}=useAppState(); return settings
  ? <FluentProvider theme={webLightTheme}><AiConfigSection settings={settings} update={update}/></FluentProvider> : null; }
const target=document.getElementById('root'); if(target) createRoot(target).render(<Fixture/>);`;
  writeFileSync(join(out, 'fixture.tsx'), fixture);
  const esbuild = require('esbuild');
  esbuild.buildSync({ entryPoints: [join(out, 'fixture.tsx')], outfile: join(out, 'renderer.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const preload = `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('settingsApi',{
  platform:'win',getSettings:()=>ipcRenderer.invoke('fixture:get'),setSettings:p=>ipcRenderer.invoke('fixture:set',p),
  getStatus:async()=>({enabled:true,helper:'running',staleAccess:false}),
  onSettings:cb=>{const f=(_e,s)=>cb(s);ipcRenderer.on('fixture:settings',f);return()=>ipcRenderer.removeListener('fixture:settings',f)},
  onStatus:()=>()=>{},getAiStatus:async()=>({encryptionAvailable:true,hasKey:false,configured:false}),
  setAiKey:()=>ipcRenderer.invoke('fixture:forbidden'),clearAiKey:()=>ipcRenderer.invoke('fixture:forbidden'),
  testAiConnection:()=>ipcRenderer.invoke('fixture:forbidden')
});`;
  writeFileSync(join(out, 'preload.cjs'), preload);
  writeFileSync(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; '
    + 'style-src \'self\' \'unsafe-inline\'; connect-src \'none\'">'
    + '<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  esbuild.buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true, platform: 'node',
    format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_SETTINGS_FIXTURE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), '--user-data-dir=' + join(out, 'profile')],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
} else {
  run();
}

function run() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const { DEFAULT_SETTINGS } = require('../src/shared/settings.ts');
  let settings = { ...DEFAULT_SETTINGS, aiBaseUrl: 'https://mock.invalid/v1', aiModel: 'mock-vision' };
  const pending = [];
  let externalRequests = 0;
  let forbiddenCalls = 0;
  let saves = 0;
  let lastPosition = null;
  const check = (ok, code) => { if (!ok) throw Error(code); };
  const wait = async (probe, code) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (await probe()) return; await new Promise(r => setTimeout(r, 20)); }
    throw Error(code);
  };
  app.whenReady().then(async () => {
    let card;
    try {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const external = /^https?:/.test(details.url); if (external) externalRequests++;
        callback({ cancel: external });
      });
      ipcMain.handle('fixture:get', () => settings);
      ipcMain.handle('fixture:forbidden', () => { forbiddenCalls++; throw Error('forbiddenFixtureCall'); });
      ipcMain.handle('fixture:set', (event, patch) => {
        check(Object.keys(patch).every(k => ['aiBaseUrl', 'aiModel'].includes(k)), 'unexpectedSettingWrite');
        saves++;
        return new Promise(done => pending.push(() => {
          settings = { ...settings, ...patch };
          event.sender.send('fixture:settings', settings);
          done({ ok: true, settings });
        }));
      });
      const out = join(process.env.LOLPING_SETTINGS_FIXTURE_ROOT, 'out/settings-input-smoke');
      card = new BrowserWindow({ width: 1120, height: 700, show: false,
        webPreferences: { preload: join(out, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await card.loadFile(join(out, 'index.html'));
      const evaluate = code => card.webContents.executeJavaScript(code);
      const paint = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const field = index => `document.querySelectorAll('input')[${index}]`;
      const focus = async (index, start, end = start) => {
        await evaluate(`${field(index)}.focus();${field(index)}.setSelectionRange(${start},${end})`);
        await paint();
      };
      const assertField = async (index, value, caret, code) => {
        const actual = await evaluate(`(()=>{const e=${field(index)};return {matches:e.value===${JSON.stringify(value)},
          caret:e.selectionStart,end:e.selectionEnd,length:e.value.length}})()`);
        lastPosition = { field: index, caret: actual.caret, end: actual.end, length: actual.length, expectedCaret: caret };
        check(actual.matches, code + 'Value');
        check(actual.caret === caret && actual.end === caret, code + 'Caret');
      };
      const release = async (all = false) => {
        await wait(() => pending.length > 0, 'saveMissing');
        do { pending.shift()(); } while (all && pending.length);
        await paint();
      };
      await wait(() => evaluate('document.querySelectorAll("input").length===3'), 'rendererMissing');
      card.show(); card.focus();
      await focus(1, 4);
      await card.webContents.insertText('X'); await paint();
      await assertField(1, 'mockX-vision', 5, 'middleInsertPending');
      await card.webContents.insertText('Y'); await paint();
      await assertField(1, 'mockXY-vision', 6, 'rapidInsertPending');
      await release();
      await assertField(1, 'mockXY-vision', 6, 'olderReply');
      await release(true);
      await assertField(1, 'mockXY-vision', 6, 'latestReply');
      card.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      card.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      await paint();
      await assertField(1, 'mockX-vision', 5, 'middleDelete');
      await release(true);
      await focus(1, 4, 5);
      await card.webContents.insertText('中文'); await paint();
      await assertField(1, 'mock中文-vision', 6, 'unicodeReplace');
      await release(true);
      await assertField(1, 'mock中文-vision', 6, 'unicodeReply');
      await focus(0, 13);
      await card.webContents.insertText('x'); await paint();
      const base = 'https://mock.invalid/v1';
      const edited = base.slice(0, 13) + 'x' + base.slice(13);
      await assertField(0, edited, 14, 'baseUrlInsert');
      await release(true);
      await assertField(0, edited, 14, 'baseUrlReply');
      await evaluate(`${field(0)}.blur()`); await paint();
      check(settings.aiModel === 'mock中文-vision' && settings.aiBaseUrl === edited, 'persistedDraftMismatch');
      check(externalRequests === 0 && forbiddenCalls === 0, 'fixturePrivacyFailure');
      console.log(JSON.stringify({ status: 'PASS', syntheticOnly: true, actualFluentInputs: true,
        middleInsert: true, rapidInput: true, olderReply: true, middleDelete: true, unicodeReplace: true,
        baseUrlEditing: true, persisted: true, saves, externalRequests, aiCalls: forbiddenCalls }));
      app.exit(0);
    } catch (error) {
      const code = /^[a-zA-Z][a-zA-Z0-9]{0,65}$/.test(error.message) ? error.message : 'unexpectedFixtureFailure';
      console.log(JSON.stringify({ status: 'FAIL', code, syntheticOnly: true, lastPosition, externalRequests, aiCalls: forbiddenCalls }));
      app.exit(1);
    }
  });
}
