import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { formatError } from "../domain/wiki-model";
import type { WikiBackend, WikiPreviewPayload, WikiPreviewRequest } from "../types";

export function useWikiPreview(backend: WikiBackend) {
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPayload, setPreviewPayload] = useState<WikiPreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewPinned, setPreviewPinned] = useState(false);
  const previewToken = useRef(0);
  const previewHideTimer = useRef<number | null>(null);
  const previewPinnedRef = useRef(false);

  useEffect(() => {
    previewPinnedRef.current = previewPinned;
  }, [previewPinned]);

  const openPreview = useCallback(async (anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): Promise<void> => {
    if (previewHideTimer.current) {
      window.clearTimeout(previewHideTimer.current);
      previewHideTimer.current = null;
    }
    const token = previewToken.current + 1;
    previewToken.current = token;
    setPreviewRect(anchor.getBoundingClientRect());
    setPreviewLoading(true);
    setPreviewPayload(null);
    setPreviewError("");
    setPreviewPinned(pin);
    previewPinnedRef.current = pin;
    try {
      const payload = await backend.previewContent(request);
      if (previewToken.current !== token) return;
      setPreviewPayload(payload);
      setPreviewError(payload && payload.ok === false ? payload.error : "");
    } catch (cause) {
      if (previewToken.current !== token) return;
      setPreviewError(formatError(cause));
    } finally {
      if (previewToken.current === token) {
        setPreviewLoading(false);
      }
    }
  }, [backend]);

  const hidePreview = useCallback((force: boolean): void => {
    if (previewHideTimer.current) {
      window.clearTimeout(previewHideTimer.current);
      previewHideTimer.current = null;
    }
    if (force) {
      previewToken.current += 1;
      setPreviewPinned(false);
      previewPinnedRef.current = false;
      setPreviewRect(null);
      setPreviewLoading(false);
      setPreviewPayload(null);
      setPreviewError("");
      return;
    }
    if (previewPinnedRef.current) {
      return;
    }
    previewHideTimer.current = window.setTimeout(() => {
      previewToken.current += 1;
      setPreviewPinned(false);
      previewPinnedRef.current = false;
      setPreviewRect(null);
      setPreviewLoading(false);
      setPreviewPayload(null);
      setPreviewError("");
    }, 120);
  }, []);

  const handleArticlePreviewOpen = useCallback((anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void => {
    void openPreview(anchor, request, pin);
  }, [openPreview]);

  const keepPreviewOpen = useCallback((): void => {
    if (previewHideTimer.current) {
      window.clearTimeout(previewHideTimer.current);
      previewHideTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!previewRect) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hidePreview(true);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!previewPinnedRef.current) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".wiki-preview-card") || target.closest("[data-preview-kind]")) {
        return;
      }
      hidePreview(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [hidePreview, previewRect]);

  return {
    previewRect,
    previewLoading,
    previewPayload,
    previewError,
    previewPinned,
    handleArticlePreviewOpen,
    hidePreview,
    keepPreviewOpen,
  };
}
