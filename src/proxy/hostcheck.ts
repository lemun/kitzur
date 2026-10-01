// Host-header check against DNS rebinding (DESIGN.md "Security"). The proxy binds to loopback, but a
// browser page on a rebinding domain can still reach it; such requests carry the attacker's host name
// in `Host`. Only the configured names are served (port ignored); a missing Host (HTTP/1.0 tools) is
// allowed, as in gobstopper; `['*']` turns the check off.

/** The host name of a Host header value: port removed, IPv6 brackets removed, lower-cased. */
export function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  // anything after the name must be a port: "localhost:80@evil.example" or "[::1]x" is not "localhost" / "::1"
  const port = (rest: string): boolean => rest === '' || /^:\d*$/.test(rest);
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 && port(h.slice(end + 1)) ? h.slice(1, end) : h;
  }
  const colon = h.indexOf(':');
  // more than one colon without brackets: a bare IPv6 literal (no port)
  if (colon >= 0 && h.indexOf(':', colon + 1) < 0) return port(h.slice(colon)) ? h.slice(0, colon) : h;
  return h;
}

/** Normalizes an allowlist entry the same way ("[::1]" and "::1" both mean ::1). */
const normalize = (a: string): string => {
  const t = a.trim().toLowerCase();
  return t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
};

/** true when a request with this Host header may be served. */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes('*')) return true;
  if (host === undefined || host.trim() === '') return true;
  const name = hostName(host);
  return allowed.some((a) => normalize(a) === name);
}
