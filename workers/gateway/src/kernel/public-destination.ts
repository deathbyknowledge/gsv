/**
 * Whether a WHATWG URL hostname names a host on the public internet. The URL
 * parser has already normalized numeric IPv4 forms and bracketed IPv6, so this
 * classifies literal addresses by range and refuses names that only resolve
 * inside a private network. It cannot see what a public name resolves to.
 */
export function isPublicHostname(value: string): boolean {
  const host = value.replace(/\.$/, "");
  if (isLoopbackHostname(host) || /(?:^|\.)(?:local|internal|lan|home|home\.arpa)$/.test(host)) return false;
  if (!host.includes(".") && !host.startsWith("[")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (host.startsWith("[")) {
    // Only global unicast (2000::/3) is public; that excludes ::1, fc00::/7, fe80::/10 and IPv4-mapped forms.
    const [first, second] = host.slice(1, -1).split(":").map((part) => Number.parseInt(part || "0", 16));
    return !((first & 0xe000) !== 0x2000 || first === 0x2002 || (first === 0x2001 && (second < 0x200 || second === 0xdb8)) || (first === 0x3fff && second <= 0xfff));
  }
  return true;
}

export function isLoopbackHostname(value: string): boolean {
  const host = value.replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d+){3}$/.test(host);
}
