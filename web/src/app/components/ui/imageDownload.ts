/** How the lightbox's download control has to behave for a given source.
 *
 *  `<a download>` is only honoured for same-origin and blob:/data: URLs. A chat
 *  image can also carry a remote http(s) URL (see chatMediaSource), and there
 *  the browser silently ignores `download` and *navigates* instead — which,
 *  in a single-page app, means the whole shell is torn down and replaced by the
 *  image. So a cross-origin source has to be fetched into a blob first. */
export function isDirectDownloadSource(source: string, pageUrl: string): boolean {
  // An empty href resolves to the page itself, which is never the image.
  if (!source.trim()) {
    return false;
  }
  let url: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    url = new URL(source, pageUrl);
  } catch {
    return false;
  }
  // Our own object URLs and inline data carry no origin to violate.
  if (url.protocol === "blob:" || url.protocol === "data:") {
    return true;
  }
  return url.origin === page.origin;
}

/** Fetch a cross-origin image and hand it to the browser as a local blob, so
 *  the download attribute applies and the current page survives. Resolves
 *  false when the fetch is refused (no CORS headers, network error) — which a
 *  host is entitled to do while still serving the <img> — leaving the caller
 *  to offer the reader another way to the file. */
export async function downloadViaBlob(source: string, filename: string): Promise<boolean> {
  let objectUrl = "";
  try {
    const response = await fetch(source, { mode: "cors", credentials: "omit" });
    if (!response.ok) {
      return false;
    }
    objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";
    link.click();
    return true;
  } catch {
    return false;
  } finally {
    if (objectUrl) {
      // Revoking in the same task can cancel the download the click just
      // started, so let it get underway first.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
}
