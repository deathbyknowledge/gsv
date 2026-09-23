type SpaceAddress = { origin: string | null; suffix: string };

/** Resolve human input here; the native session still accepts only a canonical origin. */
export function spaceAddress(input: string): SpaceAddress {
  const value = input.trim();
  const handle = value.toLowerCase() !== "localhost" && /^[a-z0-9-]*$/i.test(value);
  const suffix = handle ? ".gsv.space" : "";
  const invalid = { origin: null, suffix };
  if (!value || /[\s\\]/.test(value)) return invalid;
  if (handle && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) return invalid;

  try {
    const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
    let url = new URL(explicitScheme ? value : `https://${value}${suffix}`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!explicitScheme && loopback) url = new URL(`http://${value}`);
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    if (!(url.protocol === "https:" || url.protocol === "http:" && loopback)
      || url.username || url.password || url.search || url.hash
      || !["/", "/ws", "/ws/"].includes(url.pathname)) return invalid;
    return { origin: url.origin, suffix };
  } catch { return invalid; }
}
