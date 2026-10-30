import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { LoadingState } from "../../../components/ui/Spinner";
import { useT } from "../../../i18n/locale";
import { useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import { renderMarkdownHtml } from "../shared/markdown";
import { enhanceCodeBlocks } from "../shared/codeBlocks";
import { attachmentPreviewKind, TEXT_PREVIEW_LIMIT } from "./attachmentKind";
import "./attachment-preview.css";

/** A read-only projection of the already-authorized, immutable attachment bytes. */
export function AttachmentPreview({ blob, mimeType, filename, description, onClose }: {
  blob: Blob;
  mimeType: string;
  filename: string;
  description: string;
  onClose: () => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const kind = attachmentPreviewKind(mimeType || blob.type, filename);
  const source = useMediaObjectUrl(blob);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isText = kind === "text" || kind === "markdown";
  const tooLarge = isText && blob.size > TEXT_PREVIEW_LIMIT;
  const html = useMemo(() => kind === "markdown" && text !== null ? renderMarkdownHtml(text) : "", [kind, text]);

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!isText || tooLarge) return;
    let active = true;
    void blob.arrayBuffer().then((bytes) => {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (active) setText(decoded);
    }).catch((cause: Error) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [blob, isText, tooLarge]);
  useLayoutEffect(() => {
    if (content.current && html) enhanceCodeBlocks(content.current);
  }, [html]);

  return <dialog ref={dialog} class="attachment-preview" data-instrument-dialog aria-label={filename}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <header>
      <span>{filename}</span>
      {source && <a href={source} download={filename}>{t("fleet.file.download")}</a>}
      <button type="button" autoFocus onClick={onClose}>{t("shell.close")} <kbd>esc</kbd></button>
    </header>
    <div class="attachment-preview-content">
      {error ? <div role="alert"><p>{t("chat.media.loadFailed", { filename })}</p><details><summary>{t("chat.media.previewDetails")}</summary><pre>{error}</pre></details></div>
        : tooLarge ? <p>{t("chat.media.previewTooLarge")}</p>
        : kind === "unsupported" ? <p>{t("fleet.file.downloadToOpen")}</p>
        : isText ? text === null ? <LoadingState>{t("chat.media.loading", { filename })}</LoadingState>
          : kind === "markdown" ? <div ref={content} class="zen-prose" dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{text}</pre>
        : !source ? <LoadingState>{t("chat.media.loading", { filename })}</LoadingState>
        : kind === "image" ? <img src={source} alt={description} onError={() => setError(t("desktop.attachment.openFailed"))} />
        : <object data={source} type="application/pdf" aria-label={filename}><p>{t("chat.media.pdfUnavailable")}</p></object>}
    </div>
    {kind === "pdf" && <p class="attachment-preview-note">{t("chat.media.pdfUnavailable")}</p>}
  </dialog>;
}
