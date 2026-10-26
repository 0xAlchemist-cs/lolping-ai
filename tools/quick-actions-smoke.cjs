/* Actual Fluent controls with synthetic settings and manually released IPC; never launches a program or website. */
const { join, resolve } = require('node:path');
const { cpSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/quick-actions-smoke');
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'out/renderer/textures'), join(root, 'out/textures'), { recursive: true });
  writeFileSync(join(out, 'fixture.tsx'), `import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme} from '@fluentui/react-components';
import {QuickActionsSection} from '../../src/renderer/settings/components/QuickActionsSection';
import {FeaturesSection} from '../../src/renderer/settings/components/FeaturesSection';
import {useAppState} from '../../src/renderer/settings/useAppState';
import {TextContext} from '../../src/renderer/settings/text';
import {strings} from '../../src/shared/i18n';
import '../../src/renderer/settings/settings.css';
function Fixture(){const {settings,update}=useAppState();return settings ? <FluentProvider theme={webLightTheme}>
<TextContext.Provider value={strings(settings.language==='zh-CN'?'zh-CN':'en')}>
<QuickActionsSection settings={settings} update={update}/><div id="features"><FeaturesSection settings={settings} update={update}/></div>
</TextContext.Provider></FluentProvider>:null;}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  writeFileSync(join(out, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('settingsApi',{
platform:process.argv.find(x=>x.startsWith('--fixture-platform='))?.split('=')[1]||'win',
getSettings:()=>ipcRenderer.invoke('fixture:get'),setSettings:p=>ipcRenderer.invoke('fixture:set',p),
getStatus:async()=>({enabled:true,helper:'running'}),onStatus:()=>()=>{},
onSettings:cb=>{const f=(_e,s)=>cb(s);ipcRenderer.on('fixture:settings',f);return()=>ipcRenderer.removeListener('fixture:settings',f)},
pickQuickActionProgram:()=>ipcRenderer.invoke('fixture:pick'),saveQuickAction:(id,draft)=>ipcRenderer.invoke('fixture:save',id,draft),
removeQuickAction:id=>ipcRenderer.invoke('fixture:remove',id),testQuickAction:id=>ipcRenderer.invoke('fixture:test',id)
});`);
  const esbuild = require('esbuild');
  esbuild.buildSync({ entryPoints: [join(out, 'fixture.tsx')], outfile: join(out, 'renderer.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  writeFileSync(join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; '
    + 'style-src \'self\' \'unsafe-inline\'; img-src \'self\'; connect-src \'none\'">'
    + '<link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  esbuild.buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true, platform: 'node',
    format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_ACTION_FIXTURE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), '--user-data-dir=' + join(out, 'profile')],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exit(child.status ?? 1);
} else run();

function run() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  app.on('window-all-closed', () => {}); // Platform fixtures replace the only window between runs.
  const { DEFAULT_SETTINGS, mergeSettings } = require('../src/shared/settings.ts');
  const { strings } = require('../src/shared/i18n.ts');
  let settings = { ...DEFAULT_SETTINGS, language: 'en', quickActions: { version: 1, bindings: {
    danger: { enabled: true, name: 'Saved website', target: { kind: 'web', url: 'https://saved.invalid' } },
    push: { enabled: true, name: 'Saved app', target: { kind: 'app', exePath: 'C:\\fixture\\saved.exe' } },
    assist: { enabled: false, name: 'Disabled', target: { kind: 'toggleDesktop' } },
  } } };
  let card;
  let externalRequests = 0;
  let tests = 0;
  let saves = 0;
  let removes = 0;
  let picks = 0;
  let stage = 'setup';
  let pendingSave;
  let pendingPick;
  let savedDraft;
  const check = (condition, code) => { if (!condition) throw Error(code); };
  const wait = async (probe, code) => {
    const until = Date.now() + 8000;
    while (Date.now() < until) { if (await probe()) return; await new Promise(done => setTimeout(done, 20)); }
    throw Error(code);
  };
  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const external = /^https?:/.test(details.url); if (external) externalRequests++;
        callback({ cancel: external });
      });
      ipcMain.handle('fixture:get', () => settings);
      ipcMain.handle('fixture:set', (event, patch) => {
        settings = mergeSettings(settings, patch); event.sender.send('fixture:settings', settings); return { ok: true, settings };
      });
      ipcMain.handle('fixture:pick', () => { picks++; return new Promise(done => { pendingPick = done; }); });
      ipcMain.handle('fixture:save', (_event, id, draft) => {
        check(id !== 'missing' && !('exePath' in draft.target), 'unsafeSavePayload');
        saves++; savedDraft = { id, draft };
        return new Promise(done => { pendingSave = () => {
          const target = draft.target.kind === 'app' ? { kind: 'app', exePath: draft.target.programToken
            ? 'C:\\fixture\\chosen.exe' : settings.quickActions.bindings[id].target.exePath } : draft.target;
          settings = { ...settings, quickActions: { version: 1, bindings: {
            ...settings.quickActions.bindings, [id]: { enabled: draft.enabled, name: draft.name, target },
          } } };
          card.webContents.send('fixture:settings', settings);
          done({ ok: true, settings }); pendingSave = null;
        }; });
      });
      ipcMain.handle('fixture:remove', (_event, id) => {
        removes++;
        const bindings = { ...settings.quickActions.bindings }; delete bindings[id];
        settings = { ...settings, quickActions: { version: 1, bindings } };
        card.webContents.send('fixture:settings', settings); return { ok: true, settings };
      });
      ipcMain.handle('fixture:test', (_event, id) => {
        check(settings.quickActions.bindings[id]?.enabled, 'disabledTest'); tests++;
        return id === 'push' ? { ok: true, status: 'launchSubmitted' } : { ok: false, code: 'activationDenied' };
      });
      const out = join(process.env.LOLPING_ACTION_FIXTURE_ROOT, 'out/quick-actions-smoke');
      const open = async (platform = 'win') => {
        if (card) card.destroy();
        card = new BrowserWindow({ width: 1100, height: 950, show: false, webPreferences: {
          preload: join(out, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
          additionalArguments: ['--fixture-platform=' + platform],
        } });
        await card.loadFile(join(out, 'index.html'));
      };
      const evaluate = code => card.webContents.executeJavaScript(code);
      const paint = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
      const click = async text => { await evaluate(`${button(text)}.click()`); await paint(); };
      const select = async id => {
        await evaluate(`document.querySelectorAll('.qaTile')[${ALL_IDS.indexOf(id)}].click()`); await paint();
      };
      const field = index => `document.querySelectorAll('.qaEditor input:not([type="checkbox"])')[${index}]`;
      const fill = async (index, value) => {
        await evaluate(`${field(index)}.focus();${field(index)}.select()`);
        await card.webContents.insertText(value); await paint();
      };
      const type = async kind => {
        await evaluate(`document.querySelector('.qaEditor [role="combobox"]').click()`); await paint();
        await evaluate(`[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent===${JSON.stringify(strings('en').quickActions.types[kind])}).click()`);
        await paint();
      };
      await open();
      await wait(() => evaluate('!!document.querySelector("[data-quick-action=danger]")'), 'editorMissing');
      await wait(() => evaluate('[...document.querySelectorAll(".qaOverview img")].every(image=>image.complete&&image.naturalWidth>0)'), 'pingIconsNotLoaded');
      card.show(); card.focus();
      await paint();
      writeFileSync(join(out, 'quick-actions.png'), (await card.webContents.capturePage()).toPNG());
      stage = 'draft';
      check(settings.features.quickActions === false, 'globalDefault');
      check(await evaluate('document.querySelectorAll(".qaSlot").length===8&&document.querySelectorAll(".qaTile").length===12'), 'iconSelectionMissing');
      await fill(1, 'http://plain.invalid');
      check(await evaluate(`${button(strings('en').quickActions.save)}.disabled`), 'insecureUrlSaveEnabled');
      check(await evaluate(`document.querySelector('.qaEditor').textContent.includes(${JSON.stringify(strings('en').quickActionErrors.invalidUrl)})`), 'invalidUrlFeedbackMissing');
      await fill(0, 'Unsaved 中文');
      await fill(1, 'https://draft.invalid');
      check(saves === 0, 'typingSaved');
      check(await evaluate(`${button(strings('en').quickActions.test)}.disabled`), 'dirtyTestEnabled');
      settings = { ...settings, volume: 39, quickActions: structuredClone(settings.quickActions) };
      card.webContents.send('fixture:settings', settings); await paint();
      check(await evaluate(`${field(0)}.value==='Unsaved 中文'&&${field(1)}.value==='https://draft.invalid'`), 'pushClobberedDraft');
      await click(strings('en').quickActions.save);
      await wait(() => !!pendingSave, 'saveMissing');
      check(savedDraft.id === 'danger' && savedDraft.draft.target.url === 'https://draft.invalid', 'wrongDraftSaved');
      await select('push'); pendingSave(); await paint();
      check(await evaluate(`${field(0)}.value==='Saved app'`), 'lateSaveClobberedSelection');
      stage = 'savedTest';
      await click(strings('en').quickActions.test);
      await wait(() => evaluate(`document.body.textContent.includes(${JSON.stringify(strings('en').quickActions.results.launchSubmitted)})`), 'submittedResultMissing');
      check(tests === 1 && settings.features.quickActions === false, 'globalOffTestFailed');
      await click(strings('en').quickActions.save);
      await wait(() => !!pendingSave, 'appResaveMissing');
      check(savedDraft.draft.target.kind === 'app' && !('programToken' in savedDraft.draft.target), 'existingAppTokenRequired');
      pendingSave(); await paint();
      await select('assist');
      check(await evaluate(`${button(strings('en').quickActions.test)}.disabled`), 'disabledActionTestEnabled');
      stage = 'picker';
      await select('omw'); await type('app');
      await click(strings('en').quickActions.chooseProgram);
      await wait(() => !!pendingPick, 'pickerMissing');
      await type('web');
      pendingPick({ token: 'stale-token', exePath: 'C:\\fixture\\stale.exe', name: 'Stale program' }); pendingPick = null; await paint();
      check(await evaluate(`${field(0)}.value===''&&${field(1)}.value===''`), 'latePickerClobberedType');
      await fill(1, 'https://host.invalid/path');
      check(await evaluate(`${field(0)}.value==='host.invalid'`), 'hostnameDefaultMissing');
      await type('app'); await click(strings('en').quickActions.chooseProgram);
      await wait(() => !!pendingPick, 'secondPickerMissing');
      await select('allin');
      pendingPick({ token: 'wrong-icon-token', exePath: 'C:\\fixture\\wrong.exe', name: 'Wrong icon' }); pendingPick = null; await paint();
      check(await evaluate(`${field(0)}.value===''`), 'latePickerClobberedIcon');
      await type('app'); await click(strings('en').quickActions.chooseProgram);
      await wait(() => !!pendingPick, 'thirdPickerMissing');
      pendingPick({ token: 'chosen-token', exePath: 'C:\\fixture\\chosen.exe', name: 'Chosen program' }); pendingPick = null; await paint();
      check(await evaluate(`${field(0)}.value==='Chosen program'&&${field(1)}.readOnly`), 'programDefaultMissing');
      await click(strings('en').quickActions.save); await wait(() => !!pendingSave, 'chosenSaveMissing');
      check(savedDraft.id === 'allin' && savedDraft.draft.target.programToken === 'chosen-token', 'pickerTokenMissing');
      pendingSave(); await paint();
      await click(strings('en').quickActions.remove); await paint();
      check(!settings.quickActions.bindings.allin && removes === 1, 'removeFailed');
      stage = 'reserved';
      card.focus();
      await evaluate(`document.querySelectorAll('.qaTile')[${ALL_IDS.indexOf('missing')}].focus()`);
      await paint();
      card.webContents.debugger.attach('1.3');
      await card.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter',
        code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await card.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter',
        code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      card.webContents.debugger.detach();
      await paint();
      check(await evaluate(`!document.querySelector('[data-quick-action]')&&!!${button(strings('en').quickActions.openAi)}&&!${button(strings('en').quickActions.save)}`), 'reservedEditable');
      await select('danger'); await click(strings('en').quickActions.test);
      await wait(() => evaluate(`document.querySelector('[role="alert"]')?.textContent===${JSON.stringify(strings('en').quickActionErrors.activationDenied)}`), 'localizedErrorMissing');
      stage = 'languagesPlatforms';
      settings = { ...settings, language: 'zh-CN' }; card.webContents.send('fixture:settings', settings); await paint();
      check(await evaluate(`!!${button(strings('zh-CN').quickActions.save)}`), 'chineseMissing');
      for (const platform of ['mac', 'linux']) {
        await open(platform);
        await wait(() => evaluate('document.querySelectorAll("#features input").length>0'), 'featuresMissing');
        check(await evaluate(`!document.querySelector('.qaOverview')&&!document.body.textContent.includes(${JSON.stringify(strings('zh-CN').featureTitle.quickActions)})`), 'unsupportedFeatureVisible');
      }
      check(externalRequests === 0, 'networkRequest');
      console.log(JSON.stringify({ status: 'PASS', syntheticOnly: true, actualFluentControls: true, saves, tests, picks, removes,
        draftPushProtected: true, lateSaveProtected: true, latePickerTypeProtected: true, latePickerIconProtected: true,
        globalOffTest: true, disabledTestBlocked: true, retainedAppResave: true, defaultNames: true, tokenOnlySave: true,
        reservedAi: true, keyboardSelection: true, pingIconsLoaded: true, bilingual: true, hiddenOnMacAndLinux: true, externalRequests }));
      app.exit(0);
    } catch (error) {
      console.log(JSON.stringify({ status: 'FAIL', stage, code: error.message, saves, tests, picks, removes, externalRequests }));
      app.exit(1);
    }
  });
}

const ALL_IDS = ['danger', 'push', 'omw', 'allin', 'assist', 'needvision', 'missing', 'enemyvision', 'generic', 'bait', 'visioncleared', 'missingflip'];
