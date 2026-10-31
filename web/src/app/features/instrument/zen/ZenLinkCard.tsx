import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Surface } from "../../../components/ui/Surface";
import { fetchLinkPreview, fetchLinkPreviewImage } from "../../../services/chat/backend/linkPreviewService";
import { publicDeployment } from "../../../services/deployment";
import { useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { extractMessageLinks } from "./linkPreviews";

/** A page read stays fresh for a day on this device; a failure is not kept, so the next view asks again. */
const PREVIEW_STALE_MS = 24 * 60 * 60 * 1000;

export function linkPreviewQueryKey(url: string) {
  return ["link-preview", url] as const;
}

export function linkPreviewImageQueryKey(url: string) {
  return ["link-preview-image", url] as const;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** How far outside the viewport a message's cards start resolving, so they are ready as it scrolls in. */
const NEAR_VIEWPORT_MARGIN = "50% 0px";

/**
 * Whether the element has come near the viewport. Previews resolve only for messages the person is about to see, so
 * opening a long history fetches nothing for the pages it scrolled past. Without an observer, everything is near.
 */
function useNearViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => !("IntersectionObserver" in window));
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin: NEAR_VIEWPORT_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
}

/**
 * Links to a Ship itself get no card: they need a session the preview fetch does not carry, and a page that
 * changes something on a GET should not run because someone scrolled past it.
 */
export function previewableLink(url: string, ownHost: string, shipDomains: readonly string[]): boolean {
  const host = hostname(url);
  return host !== ownHost && !shipDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** One card per web link in a settled Ship message; links whose page offers nothing take no room. */
export function ZenLinkCards({ text }: { text: string }) {
  const links = useMemo(() => {
    const { primaryDomain, legacyDomains = [] } = publicDeployment();
    const shipDomains = [primaryDomain, ...legacyDomains].filter((domain): domain is string => Boolean(domain));
    const ownHost = globalThis.location?.hostname.replace(/^www\./i, "") ?? "";
    return extractMessageLinks(text).filter((url) => previewableLink(url, ownHost, shipDomains));
  }, [text]);
  const { ref, near } = useNearViewport();
  if (links.length === 0) return null;
  return <div class="zen-link-cards" ref={ref}>{near ? links.map((url) => <ZenLinkCard key={url} url={url} />) : null}</div>;
}

/** The page behind a link, as this device read it through `net.fetch`. Until it resolves, or when it fails or is empty, nothing shows. */
export function ZenLinkCard({ url }: { url: string }) {
  const { client, connected } = useGateway();
  const query = useQuery({
    queryKey: linkPreviewQueryKey(url),
    queryFn: () => fetchLinkPreview(client, url),
    enabled: connected,
    staleTime: PREVIEW_STALE_MS,
    retry: false,
  });
  const preview = query.data;
  if (!preview || (!preview.title && !preview.imageUrl)) return null;
  const site = preview.siteName || hostname(preview.resolvedUrl) || hostname(preview.url);
  return <a class="zen-link-card" href={preview.url} target="_blank" rel="noopener noreferrer">
    <Surface level={1} interactive>
      {preview.imageUrl ? <ZenLinkImage url={preview.imageUrl} /> : null}
      <span class="zen-link-card-text">
        {site ? <span class="zen-link-card-site">{site}</span> : null}
        {preview.title ? <span class="zen-link-card-title">{preview.title}</span> : null}
        {preview.description ? <span class="zen-link-card-description">{preview.description}</span> : null}
      </span>
    </Surface>
  </a>;
}

/** The image holds its box while it loads, so the card does not grow under the reader; a failed image gives the room back. */
function ZenLinkImage({ url }: { url: string }) {
  const { client, connected } = useGateway();
  const image = useQuery({
    queryKey: linkPreviewImageQueryKey(url),
    queryFn: () => fetchLinkPreviewImage(client, url),
    enabled: connected,
    staleTime: PREVIEW_STALE_MS,
    retry: false,
  });
  const source = useMediaObjectUrl(image.data);
  if (image.isError) return null;
  return <span class="zen-link-card-image">{source ? <img src={source} alt="" decoding="async" /> : null}</span>;
}
