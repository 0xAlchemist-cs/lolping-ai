import { describe, expect, it } from 'vitest';
import { ALL_PINGS } from '../../src/shared/pings';
import {
  isActionPingId, isLocalExePath, normalizeQuickActionBinding, normalizeQuickActionUrl, normalizeQuickActions,
} from '../../src/shared/quickActions';

describe('quickActions', () => {
  it('allows every ping except the reserved upright missing ping', () => {
    for (const { id } of ALL_PINGS) expect(isActionPingId(id), id).toBe(id !== 'missing');
    for (const raw of ['unknown', '', 'toString', '__proto__', null, undefined, 3, {}]) {
      expect(isActionPingId(raw)).toBe(false);
    }
  });

  it('normalizes HTTPS URLs without restricting the browser destination by DNS or IP', () => {
    for (const [raw, expected] of [
      [' https://EXAMPLE.com:443/a b?q=中文#x ', 'https://example.com/a%20b?q=%E4%B8%AD%E6%96%87#x'],
      ['https://localhost', 'https://localhost/'],
      ['https://127.0.0.1:8443', 'https://127.0.0.1:8443/'],
      ['https://[::1]', 'https://[::1]/'],
      ['https://例子.测试', 'https://xn--fsqu00a.xn--0zwm56d/'],
    ]) expect(normalizeQuickActionUrl(raw)).toBe(expected);
  });

  it('rejects non-HTTPS, missing hosts, malformed URLs and credentials', () => {
    for (const raw of [
      undefined, null, 3, {}, '', '/relative', 'example.com', 'http://example.com',
      'file:///C:/app.exe', 'javascript:alert(1)', 'data:text/html,hello', 'https://', 'https://[bad]',
      'https://user@example.com', 'https://user:secret@example.com', 'https://:secret@example.com',
    ]) expect(normalizeQuickActionUrl(raw), String(raw)).toBeNull();
  });

  it('rejects C0 and DEL controls before the URL parser can strip or escape them', () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      const control = String.fromCharCode(code);
      expect(normalizeQuickActionUrl(`${control}https://example.com`), String(code)).toBeNull();
      expect(normalizeQuickActionUrl(`https://example.com/a${control}b`), String(code)).toBeNull();
    }
  });

  it('bounds the canonical URL rather than its unescaped input length', () => {
    const atLimit = `https://example.com/${'a'.repeat(2061)}`;
    expect(normalizeQuickActionUrl(atLimit)).toBe(atLimit);
    expect(normalizeQuickActionUrl(`${atLimit}a`)).toBeNull();
    expect(normalizeQuickActionUrl(`https://example.com/${'中'.repeat(229)}`)).not.toBeNull();
    expect(normalizeQuickActionUrl(`https://example.com/${'中'.repeat(230)}`)).toBeNull();
  });

  it('accepts absolute local Windows exe paths without treating shell punctuation specially', () => {
    for (const raw of [
      'C:\\Program Files\\Example\\app.exe', "D:\\O'Brien & Sons\\APP.EXE", 'z:/Apps/app.ExE', 'C:\\程序\\应用.exe',
    ]) expect(isLocalExePath(raw), raw).toBe(true);
  });

  it('rejects non-local, relative, device and non-executable program paths', () => {
    for (const raw of [
      undefined, null, 1, {}, '', 'app.exe', '.\\app.exe', '\\app.exe', '/app.exe', 'C:app.exe',
      '\\\\server\\share\\app.exe', '//server/share/app.exe', '\\\\?\\C:\\app.exe', '\\\\.\\C:\\app.exe',
      '\\??\\C:\\app.exe', 'file:///C:/app.exe', 'C:\\Apps\\app.cmd', 'C:\\Apps\\app.exe.bat',
      'C:\\Apps\\app.exe ', 'C:\\Apps\\app.exe\\', 'C:\\Apps\\app.exe:other.exe',
      'C:\\Apps:other\\app.exe',
    ]) expect(isLocalExePath(raw), String(raw)).toBe(false);
  });

  it('rejects invalid Windows filename characters and every C0 or DEL control', () => {
    for (const char of ['<', '>', ':', '"', '|', '?', '*',
      ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), '\x7f']) {
      expect(isLocalExePath(`C:\\Apps\\bad${char}name.exe`), JSON.stringify(char)).toBe(false);
    }
  });

  it('bounds local executable paths to the Windows maximum', () => {
    const atLimit = `C:\\${'a'.repeat(32760)}.exe`;
    expect(isLocalExePath(atLimit)).toBe(true);
    expect(isLocalExePath(`C:\\a${atLimit.slice(3)}`)).toBe(false);
  });

  it('migrates the old desktop toggle to one-way clear', () => {
    expect(normalizeQuickActionBinding({ enabled: true, name: 'Desktop', target: { kind: 'toggleDesktop' } }))
      .toEqual({ enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } });
    expect(normalizeQuickActionBinding({ enabled: true, name: 'Clear', target: { kind: 'showDesktop' } }))
      .toEqual({ enabled: true, name: 'Clear', target: { kind: 'showDesktop' } });
  });

  it('rebuilds each supported target with a trimmed printable label', () => {
    expect(normalizeQuickActionBinding({ enabled: true, name: '  Docs  ', extra: 'drop',
      target: { kind: 'web', url: 'https://EXAMPLE.com', exePath: 'C:\\other.exe' } }))
      .toEqual({ enabled: true, name: 'Docs', target: { kind: 'web', url: 'https://example.com/' } });
    expect(normalizeQuickActionBinding({ enabled: false, name: '编辑器',
      target: { kind: 'app', exePath: "C:\\O'Brien & Sons\\app.exe", programToken: 'drop' } }))
      .toEqual({ enabled: false, name: '编辑器', target: { kind: 'app', exePath: "C:\\O'Brien & Sons\\app.exe" } });
    expect(normalizeQuickActionBinding({ enabled: true, name: 'Desktop', target: { kind: 'showDesktop', url: 'drop' } }))
      .toEqual({ enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } });
  });

  it('requires a boolean enabled flag, a printable label and a valid target even when disabled', () => {
    const valid = { enabled: true, name: 'Docs', target: { kind: 'web', url: 'https://example.com' } };
    for (const raw of [
      undefined, null, 3, [], {}, { ...valid, enabled: 1 }, { ...valid, enabled: undefined },
      { ...valid, name: '' }, { ...valid, name: '   ' }, { ...valid, name: 7 },
      { ...valid, name: 'bad\nname' }, { ...valid, name: 'bad\x7fname' }, { ...valid, name: 'bad\x85name' },
      { ...valid, name: 'bad\u202ename' }, { ...valid, name: 'bad\ud800name' },
      { ...valid, target: null }, { ...valid, target: [] }, { ...valid, target: {} },
      { ...valid, target: { kind: 'shell', command: 'hello' } },
      { ...valid, target: { kind: 'web', url: 'http://example.com' } },
      { ...valid, enabled: false, target: { kind: 'app', exePath: 'app.exe' } },
      { ...valid, target: { kind: 'app', programToken: 'renderer-token' } },
    ]) expect(normalizeQuickActionBinding(raw), JSON.stringify(raw)).toBeNull();
  });

  it('limits names to 64 code points without silently truncating labels', () => {
    const target = { kind: 'showDesktop' };
    expect(normalizeQuickActionBinding({ enabled: true, name: '😀'.repeat(64), target })?.name)
      .toBe('😀'.repeat(64));
    expect(normalizeQuickActionBinding({ enabled: true, name: '😀'.repeat(65), target })).toBeNull();
    expect(normalizeQuickActionBinding({ enabled: true, name: 'a'.repeat(65), target })).toBeNull();
  });

  it('returns fresh empty settings for missing, broken and unsupported configurations', () => {
    const binding = { enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } };
    for (const raw of [
      undefined, null, 1, [], {}, { version: 1 }, { version: 1, bindings: [] },
      { bindings: { danger: binding } }, { version: '1', bindings: { danger: binding } },
      { version: 2, bindings: { danger: binding } },
    ]) expect(normalizeQuickActions(raw)).toEqual({ version: 1, bindings: {} });
    const first = normalizeQuickActions(undefined);
    const second = normalizeQuickActions(undefined);
    expect(first).not.toBe(second);
    expect(first.bindings).not.toBe(second.bindings);
  });

  it('drops malformed and reserved entries individually without losing valid disabled bindings', () => {
    const desktop = { enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } };
    const raw = { version: 1, bindings: {
      danger: desktop, missing: desktop, missingflip: { ...desktop, enabled: false },
      unknown: desktop, generic: { ...desktop, name: '' }, push: { ...desktop, target: { kind: 'unknown' } },
    } };
    expect(normalizeQuickActions(raw)).toEqual({ version: 1, bindings: {
      danger: desktop, missingflip: { ...desktop, enabled: false },
    } });
  });

  it('rebuilds action data independently of the loaded input and ignores inherited bindings', () => {
    const binding = { enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } };
    const raw = { version: 1, bindings: { danger: binding } };
    const normalized = normalizeQuickActions(raw);
    expect(normalized.bindings.danger).not.toBe(binding);
    expect(normalized.bindings.danger?.target).not.toBe(binding.target);
    binding.name = '';
    expect(normalized.bindings.danger?.name).toBe('Desktop');
    expect(normalizeQuickActions({ version: 1, bindings: Object.create({ danger: binding }) }))
      .toEqual({ version: 1, bindings: {} });
  });
});
