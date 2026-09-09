import { useEffect, useState } from "preact/hooks";
import { chatMediaSource, type ChatMediaDescriptor } from "../domain/media";
import { useChatProcessMedia, useChatResource } from "./useChatProcesses";

export function useMediaObjectUrl(blob: Blob | undefined): string {
  const [object, setObject] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) { setObject(null); return; }
    const url = URL.createObjectURL(blob);
    setObject({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return object?.blob === blob ? object?.url ?? "" : "";
}

/** Both chat surfaces resolve immutable references and older stored media through the same reader. */
export function useChatMediaSource(descriptor: ChatMediaDescriptor, processId: string) {
  const { key = "", conversationId = "", resource } = descriptor;
  const inlineSource = chatMediaSource({ url: descriptor.url });
  const stored = useChatProcessMedia({
    args: conversationId ? { conversationId, key } : { key, pid: processId || undefined },
    enabled: !resource && !inlineSource && key !== "" && (conversationId !== "" || processId !== ""),
  });
  const referenced = useChatResource({ ref: resource ?? null, enabled: Boolean(resource) });
  const objectUrl = useMediaObjectUrl(referenced.data?.blob ?? stored.data?.blob);
  return {
    source: inlineSource || chatMediaSource({}, objectUrl),
    error: referenced.error ?? stored.error,
    available: Boolean(resource || inlineSource || key),
    retry: () => resource ? referenced.refetch() : stored.refetch(),
  };
}
