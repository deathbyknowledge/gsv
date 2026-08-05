export function publicTurnstileSiteKey(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  const siteKey = value.trim();
  if (
    siteKey.length < 20
    || siteKey.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(siteKey)
  ) {
    throw new Error("GSV_TURNSTILE_SITE_KEY is invalid");
  }
  return siteKey;
}

export function publicTelegramBotUsername(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  const username = value.trim().replace(/^@/, "");
  if (
    username.length < 5
    || username.length > 32
    || !/^[A-Za-z][A-Za-z0-9_]*bot$/i.test(username)
  ) {
    throw new Error("Managed Telegram bot username is invalid");
  }
  return username;
}

export async function accountPage(
  request: Request,
  assets: Fetcher | undefined,
): Promise<Response> {
  if (!assets) {
    return new Response("Account interface unavailable", { status: 503 });
  }
  const assetUrl = new URL("/account/index.html", request.url);
  const asset = await assets.fetch(new Request(assetUrl, { method: "GET" }));
  if (!asset.ok) return asset;

  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' https://challenges.cloudflare.com",
    "font-src 'self'",
    "form-action 'self' https://*.gsv.space",
    "frame-ancestors 'none'",
    "frame-src https://challenges.cloudflare.com",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "worker-src 'none'",
  ].join("; "));
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", [
    "camera=()",
    "geolocation=()",
    "microphone=()",
    "payment=()",
    "publickey-credentials-create=(self)",
    "publickey-credentials-get=(self)",
  ].join(", "));
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}
