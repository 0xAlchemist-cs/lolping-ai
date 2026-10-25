/**
 * Endpoint validation for the AI explain feature, as pure functions so tests can drive every branch.
 *
 * The rules: one remote HTTPS endpoint per user choice, no credentials in the URL, no query or fragment, and never
 * a loopback/private/reserved target — the question text and the API key must not silently travel to a LAN neighbour
 * or a local service. `allowLocalHttp` exists only for development builds against a local mock (see index.ts); the
 * DNS guard still applies to every other hostname, because a public-looking name can resolve into a private range.
 */

export interface AiEndpoint {
  /** Origin plus path, without a trailing slash: `https://host/v1` */
  url: string;
  host: string;
}

export type EndpointErrorCode =
  | 'notString' | 'tooLong' | 'badShape' | 'badScheme' | 'hasCredentials' | 'hasQueryOrFragment'
  | 'noHost' | 'privateAddress';

export type EndpointCheck = { ok: true; endpoint: AiEndpoint } | { ok: false; code: EndpointErrorCode };

export const MAX_BASE_URL = 200;
export const MAX_MODEL = 100;

/** Why a model request failed, as one stable code the UI can name in both languages. */
export type AiErrorCode =
  | 'auth' | 'rate' | 'server' | 'http' | 'network' | 'timeout' | 'aborted'
  | 'tooLong' | 'endpoint' | 'private' | 'resolve' | 'noKey' | 'badResponse'
  | 'permission' | 'notFound' | 'plan' | 'imageUnsupported' | 'imageInvalid' | 'imageTooLarge'
  | 'snapshotExpired' | 'snapshotStale' | 'consentRequired' | 'configChanged';

/** True when the string could name a model: 1..MAX_MODEL characters and no control characters. */
export function validModel(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_MODEL) return false;
  return ![...t].some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp < 0x20 || cp === 0x7f;
  });
}

const ipv4ToLong = (parts: readonly number[]): number =>
  ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;

const inV4 = (ip: readonly number[], net: readonly [number, number, number, number], bits: number): boolean => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(net) & mask);
};

/** IPv4 ranges a user must point somewhere else: loopback, RFC1918, link-local, CGNAT, benchmark, multicast, reserved. */
const V4_BLOCKED: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

export function isBlockedIpv4(ip: readonly number[]): boolean {
  return V4_BLOCKED.some(([net, bits]) => inV4(ip, net as readonly [number, number, number, number], bits));
}

/** True for loopback, unspecified, unique-local, link-local, documentation and multicast IPv6, and IPv4-mapped forms. */
export function isBlockedIpv6(groups: readonly number[]): boolean {
  const g = groups;
  const all = (from: number, to: number, v: number) => g.slice(from, to).every((x) => x === v);
  const first = g[0] ?? 0;
  if (all(0, 8, 0)) return true; // :: (unspecified) and ::1 (loopback): every group zero; ::1 caught below
  if (all(0, 7, 0) && g[7] === 1) return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if (first === 0x2001 && (g[1] & 0xfff0) === 0xdb8) return true; // 2001:db8::/32 documentation
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (all(0, 5, 0) && g[5] === 0xffff) {
    // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 coat
    return isBlockedIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  return false;
}

export type ParsedIp = { kind: 'v4'; v4: readonly number[] } | { kind: 'v6'; v6: readonly number[] } | null;

/** Parses `1.2.3.4` / `::1` style hosts; null when the host is a name, not a literal. */
export function parseIpLiteral(host: string): ParsedIp {
  const h = host.replace(/^\[|\]$/g, ''); // URL.hostname keeps brackets on IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    return parts.every((p) => p >= 0 && p <= 255) ? { kind: 'v4', v4: parts } : null;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return { kind: 'v6', v6: [0, 0, 0, 0, 0, 0, 0, h === '::1' ? 1 : 0] };
    // Only fully expanded forms are worth checking here; other compressed forms fall through to the DNS guard
    const segs = h.split(':');
    if (segs.length === 8 && segs.every((x) => /^[0-9a-fA-F]{1,4}$/.test(x))) {
      return { kind: 'v6', v6: segs.map((x) => parseInt(x, 16)) };
    }
    return null;
  }
  return null;
}

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const ip = parseIpLiteral(h);
  if (ip?.kind === 'v4') return isBlockedIpv4(ip.v4);
  if (ip?.kind === 'v6') return isBlockedIpv6(ip.v6);
  return false;
}

/**
 * Validates a base URL as received from the settings page. `allowLocalHttp` must only be true in development builds
 * with the operator's opt-in; it admits plain http on an explicit loopback host for a local mock server and nothing
 * else. Everything else needs https, no userinfo, no query, no fragment, a real host and a sane path.
 */
export function checkEndpoint(raw: unknown, allowLocalHttp = false): EndpointCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'notString' };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BASE_URL) return { ok: false, code: 'tooLong' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'badShape' };
  }
  const localLoop = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol === 'http:') {
    if (!allowLocalHttp || !localLoop) return { ok: false, code: 'badScheme' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, code: 'badScheme' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'hasCredentials' };
  if (url.search !== '' || url.hash !== '') return { ok: false, code: 'hasQueryOrFragment' };
  if (url.hostname === '') return { ok: false, code: 'noHost' };
  // The only exemption is the exact development case: http, on an explicit loopback host, with the opt-in flag.
  if (!(allowLocalHttp && localLoop) && isBlockedHost(url.hostname)) return { ok: false, code: 'privateAddress' };
  // The URL parser normalizes dot segments, so `pathname` is already canonical here.
  const base = `${url.origin}${url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : ''}`;
  return { ok: true, endpoint: { url: base, host: url.hostname } };
}

/** True when the endpoint may skip the DNS guard: an explicit loopback host that development already opted into. */
export function isExplicitLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** The address families a lookup may return, shaped like Node's `dns.lookup({ all: true })`. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * The DNS half of the guard: a hostname that looks public can still resolve into a private range. The caller passes
 * its own `lookup`, so tests cover every branch and production passes `dns.promises.lookup`. Null means "could not
 * resolve" — the caller decides; the request itself would fail anyway, so we treat it as blocked.
 */
export async function guardResolvedAddresses(
  host: string,
  lookup: (host: string) => Promise<readonly ResolvedAddress[]>,
): Promise<{ ok: true } | { ok: false; code: 'privateAddress' | 'resolveFailed' }> {
  let addrs: readonly ResolvedAddress[];
  try {
    addrs = await lookup(host);
  } catch {
    return { ok: false, code: 'resolveFailed' };
  }
  if (addrs.length === 0) return { ok: false, code: 'resolveFailed' };
  for (const { address } of addrs) {
    if (address.includes(':')) {
      // The mapped form carries IPv4 inside IPv6; check it before treating it as a bare v4 literal.
      const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
      if (mapped && isBlockedIpv4(mapped[1].split('.').map(Number))) return { ok: false, code: 'privateAddress' };
      if (address === '::1' || address === '::') return { ok: false, code: 'privateAddress' };
      const segs = address.split(':');
      if (segs.length === 8 && segs.every((x) => /^[0-9a-fA-F]{1,4}$/.test(x)) && isBlockedIpv6(segs.map((x) => parseInt(x, 16)))) {
        return { ok: false, code: 'privateAddress' };
      }
    } else if (address.includes('.')) {
      const parts = address.split('.').map(Number);
      if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255) && isBlockedIpv4(parts)) {
        return { ok: false, code: 'privateAddress' };
      }
    }
  }
  return { ok: true };
}
