import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { LoadingState } from "../app/components/ui/Spinner";
import { MediaPreviewProvider, type ImagePreview } from "../app/services/platform/MediaPreview";

function AttachmentPreview({ image, close, feedback }: { image: ImagePreview; close: () => void; feedback: ComponentChildren }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState(image.source.startsWith("blob:") ? "" : image.source);
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    if (!image.source.startsWith("blob:")) return;
    // Retain the image even if its message unmounts and releases the original URL.
    const controller = new AbortController();
    let ownedUrl = "";
    void fetch(image.source, { signal: controller.signal }).then((response) => response.blob()).then((blob) => {
      if (controller.signal.aborted) return;
      ownedUrl = URL.createObjectURL(blob);
      setSource(ownedUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [image.source]);

  return <dialog ref={dialog} class="desktop-attachment-preview" aria-label={image.filename}
    onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <header>
      <span>{image.filename}</span>
      {source && <a href={source} download={image.filename}>download</a>}
      <button type="button" autoFocus onClick={close} aria-label="Close preview">close <kbd>esc</kbd></button>
    </header>
    <div class="desktop-attachment-image">
      {failed ? <p role="alert">Could not open this image.</p> : source
        ? <img src={source} alt={image.description} onError={() => setFailed(true)} />
        : <LoadingState>Loading image…</LoadingState>}
    </div>
    {feedback}
  </dialog>;
}

export function DesktopAttachments({ children, active = true }: { children: ComponentChildren; active?: boolean }) {
  const [image, setImage] = useState<ImagePreview | null>(null);
  const [download, setDownload] = useState<{ success: boolean } | null>(null);
  useEffect(() => { if (!active) { setImage(null); setDownload(null); } }, [active]);
  useEffect(() => {
    if (!window.__TAURI__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window.__TAURI__.event.listen<boolean>("desktop-download", ({ payload }) => {
      if (!disposed) setDownload({ success: payload });
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => { if (!disposed) setDownload({ success: false }); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (!download?.success) return;
    const timer = window.setTimeout(() => setDownload(null), 5000);
    return () => window.clearTimeout(timer);
  }, [download]);
  const feedback = download && <div class="desktop-download-status" role={download.success ? "status" : "alert"}>
      <span>{download.success ? "Saved to Downloads" : "Could not save the file. Try again."}</span>
      <button type="button" onClick={() => setDownload(null)} aria-label="Dismiss download status">×</button>
    </div>;
  return <MediaPreviewProvider preview={setImage}>
    {children}
    {active && image ? <AttachmentPreview key={image.source} image={image} close={() => setImage(null)} feedback={feedback} /> : feedback}
  </MediaPreviewProvider>;
}
