export const MAX_BROWSER_STORAGE_ORIGINS = 128;
const MAX_STORAGE_ORIGIN_LENGTH = 2048;

/** Only bounded HTTP(S) origins can become durable storage-export work. */
export function rememberBrowserOrigin(origins: string[], url: string): boolean {
  if (origins.length >= MAX_BROWSER_STORAGE_ORIGINS || !/^https?:\/\//.test(url)) return false;
  let origin: string;
  try { origin = new URL(url).origin; }
  catch { return false; }
  if (origin.length > MAX_STORAGE_ORIGIN_LENGTH || origins.includes(origin)) return false;
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
