import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Surface } from "../../../components/ui/Surface";
import { fetchLinkPreview, fetchLinkPreviewImage } from "../../../services/chat/backend/linkPreviewService";
import { useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { extractMessageLinks } from "./linkPreviews";

const PREVIEW_STALE_MS = 60 * 60 * 1000;
/** A failed preview is asked for again after the Kernel's own failure expiry, so an open chat recovers from a transient error. */
export const PREVIEW_RETRY_MS = 60 * 60 * 1000;

export function previewRefetchInterval(query: { state: { status: "pending" | "error" | "success" } }): number | false {
  return query.state.status === "error" ? PREVIEW_RETRY_MS : false;
}

export function linkPreviewQueryKey(url: string) {
  return ["link-preview", url] as const;
}

export function linkPreviewImageQueryKey(key: string) {
  return ["link-preview-image", key] as const;
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

/** One card per web link in a settled Ship message; links whose page offers nothing take no room. */
export function ZenLinkCards({ text }: { text: string }) {
  const links = useMemo(() => extractMessageLinks(text), [text]);
  const { ref, near } = useNearViewport();
  if (links.length === 0) return null;
  return <div class="zen-link-cards" ref={ref}>{near ? links.map((url) => <ZenLinkCard key={url} url={url} />) : null}</div>;
}

/** The page behind a link, as the Kernel read it. Until it resolves, or when it fails or is empty, nothing shows. */
export function ZenLinkCard({ url }: { url: string }) {
  const { client, connected } = useGateway();
  const query = useQuery({
    queryKey: linkPreviewQueryKey(url),
    queryFn: () => fetchLinkPreview(client, url),
    enabled: connected,
    staleTime: PREVIEW_STALE_MS,
    retry: false,
    refetchInterval: previewRefetchInterval,
  });
  const preview = query.data;
  if (!preview || (!preview.title && !preview.image)) return null;
  const site = preview.siteName || hostname(preview.resolvedUrl) || hostname(preview.url);
  return <a class="zen-link-card" href={preview.url} target="_blank" rel="noopener noreferrer">
    <Surface level={1} interactive>
      {preview.image ? <ZenLinkImage imageKey={preview.image.key} /> : null}
      <span class="zen-link-card-text">
        {site ? <span class="zen-link-card-site">{site}</span> : null}
        {preview.title ? <span class="zen-link-card-title">{preview.title}</span> : null}
        {preview.description ? <span class="zen-link-card-description">{preview.description}</span> : null}
      </span>
    </Surface>
  </a>;
}

/** The image holds its box while it loads, so the card does not grow under the reader; a failed image gives the room back. */
function ZenLinkImage({ imageKey }: { imageKey: string }) {
  const { client, connected } = useGateway();
  const image = useQuery({
    queryKey: linkPreviewImageQueryKey(imageKey),
    queryFn: () => fetchLinkPreviewImage(client, imageKey),
    enabled: connected,
    staleTime: PREVIEW_STALE_MS,
    retry: false,
    refetchInterval: previewRefetchInterval,
  });
  const source = useMediaObjectUrl(image.data);
  if (image.isError) return null;
  return <span class="zen-link-card-image">{source ? <img src={source} alt="" decoding="async" /> : null}</span>;
}
