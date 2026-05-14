import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatBackend, ThreadContext } from "../types";
import { mediaSourceKey } from "../domain/media";
import { asRecord, asString, formatError, safeText } from "../view-helpers";

function mediaOwnerPidFromKey(key: string): string | null {
  const match = /^var\/media\/[^/]+\/(.+)\/[^/]+$/.exec(key);
  return match?.[1] || null;
}

function removeRecordKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

export function useMediaSources({
  backend,
  activeRef,
  mountedRef,
  appendSystem,
}: {
  backend: ChatBackend;
  activeRef: { current: ThreadContext | null };
  mountedRef: { current: boolean };
  appendSystem(text: string): void;
}) {
  const [mediaSources, setMediaSources] = useState<Record<string, string>>({});
  const [mediaSourceErrors, setMediaSourceErrors] = useState<Record<string, string>>({});
  const mediaSourcesRef = useRef(mediaSources);
  const mediaSourceLoadingRef = useRef<Set<string>>(new Set());
  const mediaSourceFailedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    mediaSourcesRef.current = mediaSources;
  }, [mediaSources]);

  const loadMediaSource = useCallback((media: unknown): void => {
    const key = mediaSourceKey(media);
    if (
      !key
      || mediaSourcesRef.current[key]
      || mediaSourceLoadingRef.current.has(key)
      || mediaSourceFailedRef.current.has(key)
    ) {
      return;
    }
    const targetPid = mediaOwnerPidFromKey(key) ?? activeRef.current?.pid ?? "";
    if (!targetPid) {
      return;
    }

    const record = asRecord(media);
    const mimeType = asString(record?.mimeType) || undefined;
    mediaSourceLoadingRef.current.add(key);
    backend.readProcessMedia({ pid: targetPid, key, mimeType })
      .then((result) => {
        const response = asRecord(result);
        const dataUrl = asString(response?.dataUrl);
        if (!mountedRef.current) {
          return;
        }
        if (!response?.ok || !dataUrl) {
          const error = safeText(response?.error || "media load failed");
          mediaSourceFailedRef.current.add(key);
          setMediaSourceErrors((current) => current[key] === error ? current : { ...current, [key]: error });
          return;
        }
        mediaSourceFailedRef.current.delete(key);
        setMediaSourceErrors((current) => removeRecordKey(current, key));
        setMediaSources((current) => {
          if (current[key] === dataUrl) {
            return current;
          }
          return { ...current, [key]: dataUrl };
        });
      })
      .catch((error) => {
        const message = formatError(error);
        mediaSourceFailedRef.current.add(key);
        setMediaSourceErrors((current) => current[key] === message ? current : { ...current, [key]: message });
        appendSystem("media load failed: " + message);
      })
      .finally(() => {
        mediaSourceLoadingRef.current.delete(key);
      });
  }, [activeRef, appendSystem, backend, mountedRef]);

  const retryMediaSource = useCallback((media: unknown): void => {
    const key = mediaSourceKey(media);
    if (!key) {
      return;
    }
    mediaSourceFailedRef.current.delete(key);
    setMediaSourceErrors((current) => removeRecordKey(current, key));
    loadMediaSource(media);
  }, [loadMediaSource]);

  return {
    mediaSources,
    mediaSourceErrors,
    loadMediaSource,
    retryMediaSource,
  };
}
