import { describe, expect, it } from 'vitest';
import {
  checkEndpoint, guardResolvedAddresses, isBlockedHost, isBlockedIpv4, isBlockedIpv6, validModel,
  type EndpointCheck,
} from '../../src/shared/aiConfig';

/** 'OK' for a pass, the failing code otherwise: readable on both sides of the union. */
const verdict = (r: EndpointCheck): string => (r.ok ? 'OK' : r.code);

describe('validModel', () => {
  it('accepts a real model name and rejects junk', () => {
    expect(validModel('gpt-4o-mini')).toBe(true);
    expect(validModel(' deepseek-chat ')).toBe(true);
    expect(validModel('')).toBe(false);
    expect(validModel(42)).toBe(false);
    expect(validModel('a'.repeat(101))).toBe(false);
    expect(validModel('bad\u0007name')).toBe(false);
  });
});

describe('blocked address knowledge', () => {
  it('blocks the IPv4 ranges a key must never travel to', () => {
    for (const ip of [[127, 0, 0, 1], [10, 1, 2, 3], [172, 16, 0, 1], [172, 31, 9, 9], [192, 168, 1, 1],
      [169, 254, 1, 1], [100, 64, 0, 1], [0, 0, 0, 0], [224, 0, 0, 1], [255, 255, 255, 255]]) {
      expect(isBlockedIpv4(ip), ip.join('.')).toBe(true);
    }
    for (const ip of [[1, 1, 1, 1], [8, 8, 8, 8], [172, 32, 0, 1], [100, 128, 0, 1]]) {
      expect(isBlockedIpv4(ip), ip.join('.')).toBe(false);
    }
  });

  it('blocks the IPv6 forms that mean local', () => {
    expect(isBlockedIpv6([0, 0, 0, 0, 0, 0, 0, 1])).toBe(true); // ::1
    expect(isBlockedIpv6([0, 0, 0, 0, 0, 0, 0, 0])).toBe(true); // ::
    expect(isBlockedIpv6([0xfe80, 1, 0, 0, 0, 0, 0, 1])).toBe(true); // link-local
    expect(isBlockedIpv6([0xfc00, 1, 0, 0, 0, 0, 0, 1])).toBe(true); // unique local
    expect(isBlockedIpv6([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111])).toBe(false); // a real public one
    // ::ffff:10.0.0.1 — private IPv4 in an IPv6 coat
    expect(isBlockedIpv6([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001])).toBe(true);
  });

  it('knows the hostnames that always mean local', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('printer.local')).toBe(true);
    expect(isBlockedHost('api.example.com')).toBe(false);
  });
});

describe('checkEndpoint', () => {
  it('accepts a plain https base and normalizes a trailing slash', () => {
    expect(checkEndpoint('https://api.example.com/v1')).toEqual({
      ok: true, endpoint: { url: 'https://api.example.com/v1', host: 'api.example.com' },
    });
    expect(checkEndpoint('  https://api.example.com/v1/ ')).toEqual({
      ok: true, endpoint: { url: 'https://api.example.com/v1', host: 'api.example.com' },
    });
    expect(checkEndpoint('https://api.example.com')).toEqual({
      ok: true, endpoint: { url: 'https://api.example.com', host: 'api.example.com' },
    });
  });

  it('rejects the shapes a key must never ride in', () => {
    expect(checkEndpoint(42).ok).toBe(false);
    expect(verdict(checkEndpoint('a'.repeat(201)))).toBe('tooLong');
    expect(verdict(checkEndpoint('not a url'))).toBe('badShape');
    expect(verdict(checkEndpoint('ftp://api.example.com/v1'))).toBe('badScheme');
    expect(verdict(checkEndpoint('file:///etc/passwd'))).toBe('badScheme');
    expect(verdict(checkEndpoint('https://user:pw@api.example.com/v1'))).toBe('hasCredentials');
    expect(verdict(checkEndpoint('https://api.example.com/v1?x=1'))).toBe('hasQueryOrFragment');
    expect(verdict(checkEndpoint('https://api.example.com/v1#frag'))).toBe('hasQueryOrFragment');
  });

  it('refuses private and local targets even over https', () => {
    expect(verdict(checkEndpoint('https://127.0.0.1/v1'))).toBe('privateAddress');
    expect(verdict(checkEndpoint('https://192.168.1.5/v1'))).toBe('privateAddress');
    expect(verdict(checkEndpoint('https://10.0.0.2/v1'))).toBe('privateAddress');
    expect(verdict(checkEndpoint('https://[::1]/v1'))).toBe('privateAddress');
    expect(verdict(checkEndpoint('https://localhost/v1'))).toBe('privateAddress');
  });

  it('admits an explicit loopback only with the development flag, and only http', () => {
    expect(checkEndpoint('http://127.0.0.1:8080/v1', true)).toEqual({
      ok: true, endpoint: { url: 'http://127.0.0.1:8080/v1', host: '127.0.0.1' },
    });
    // Without the flag even the loopback http is out, and with it a private non-loopback is still out.
    expect(verdict(checkEndpoint('http://127.0.0.1:8080/v1', false))).toBe('badScheme');
    expect(verdict(checkEndpoint('http://192.168.1.5/v1', true))).toBe('badScheme');
    expect(verdict(checkEndpoint('https://192.168.1.5/v1', true))).toBe('privateAddress');
  });
});

describe('guardResolvedAddresses', () => {
  const resolve = (addrs: string[]) => async () => addrs.map((address) => ({ address, family: 4 }));

  it('accepts a public answer', async () => {
    expect(await guardResolvedAddresses('api.example.com', resolve(['93.184.216.34']))).toEqual({ ok: true });
  });

  it('rejects when any resolved address is private — the DNS rebinding case', async () => {
    expect(await guardResolvedAddresses('evil.example.com', resolve(['93.184.216.34', '192.168.0.10'])))
      .toEqual({ ok: false, code: 'privateAddress' });
    expect(await guardResolvedAddresses('evil6.example.com', resolve(['::1']))).toEqual({ ok: false, code: 'privateAddress' });
    expect(await guardResolvedAddresses('mapped.example.com', resolve(['::ffff:10.0.0.1'])))
      .toEqual({ ok: false, code: 'privateAddress' });
  });

  it('reports an unresolvable host instead of guessing', async () => {
    expect(await guardResolvedAddresses('nope.example.com', async () => {
      throw new Error('ENOTFOUND');
    })).toEqual({ ok: false, code: 'resolveFailed' });
    expect(await guardResolvedAddresses('empty.example.com', resolve([]))).toEqual({ ok: false, code: 'resolveFailed' });
  });
});
