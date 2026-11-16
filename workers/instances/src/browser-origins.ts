export const MAX_BROWSER_STORAGE_ORIGINS = 128;
const MAX_STORAGE_ORIGIN_LENGTH = 2048;

/** Only bounded HTTP(S) origins can become durable storage-export work. */
export function browserStorageOrigin(url: string): string | undefined {
  if (!/^https?:\/\//.test(url)) return undefined;
  let origin: string;
  try { origin = new URL(url).origin; }
  catch { return undefined; }
  return origin.length > MAX_STORAGE_ORIGIN_LENGTH ? undefined : origin;
}

export function rememberBrowserOrigin(origins: string[], url: string): boolean {
  if (origins.length >= MAX_BROWSER_STORAGE_ORIGINS) return false;
  const origin = browserStorageOrigin(url);
  if (!origin || origins.includes(origin)) return false;
  origins.push(origin);
  return true;
}

export function boundedBrowserOrigins(...sources: Iterable<string>[]): string[] {
  const origins: string[] = [];
  for (const source of sources) {
    for (const url of source) {
      rememberBrowserOrigin(origins, url);
      if (origins.length === MAX_BROWSER_STORAGE_ORIGINS) return origins;
    }
  }
  return origins;
}
