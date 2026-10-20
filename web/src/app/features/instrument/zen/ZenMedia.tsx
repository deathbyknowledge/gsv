import { LoadingState } from "../../../components/ui/Spinner";
import { chatMediaKind, formatChatMediaSize, parseChatMedia } from "../../../services/chat/domain/media";
import { useChatMediaSource, useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import type { ChatMediaUpload } from "../../../services/chat/domain/processes";
import { useMediaPreview } from "../../../services/platform/MediaPreview";
import { useT, type TextKey } from "../../../i18n/locale";
import type { ZenPaste } from "./zenAttachments";

/** What an attachment is called when it arrives without a usable file name. */
const MEDIA_NAMES = {
  document: "chat.media.kind.document",
  image: "chat.media.kind.image",
  video: "chat.media.kind.video",
  audio: "chat.media.kind.audio",
} satisfies Record<ReturnType<typeof chatMediaKind>, TextKey>;

export function ZenDraftAttachment({ attachment, onRemove, disabled }: { attachment: ChatMediaUpload; onRemove?: () => void; disabled?: boolean }) {
  const t = useT();
  const image = attachment.type === "image";
  const source = useMediaObjectUrl(image ? attachment.body : undefined);
  return <li class="zen-draft-attachment">
    {source && <img src={source} alt="" />}
    <span class="file-name">{attachment.filename}<small>{formatChatMediaSize(attachment.body.size)}</small></span>
    {onRemove && <button type="button" onClick={onRemove} disabled={disabled} aria-label={t("chat.media.remove", { filename: attachment.filename ?? "" })}>×</button>}
  </li>;
}

const PASTE_PREVIEW_CHARACTERS = 280;

/** Long pasted text as a chip: its size stands in for the text, and hovering shows how it begins. */
export function ZenDraftPaste({ paste, onRemove, disabled }: { paste: ZenPaste; onRemove?: () => void; disabled?: boolean }) {
  const t = useT();
  const preview = paste.text.length > PASTE_PREVIEW_CHARACTERS ? `${paste.text.slice(0, PASTE_PREVIEW_CHARACTERS)}…` : paste.text;
  return <li class="zen-draft-attachment" title={preview}>
    <details class="zen-paste-preview">
      <summary class="file-name">{t("chat.media.pasted")}<small>{t("chat.media.characters", { count: paste.characters, characters: paste.characters.toLocaleString("en-US") })}</small></summary>
      <pre>{paste.text}</pre>
    </details>
    {onRemove && <button type="button" onClick={onRemove} disabled={disabled} aria-label={t("chat.media.removePasted")}>×</button>}
  </li>;
}

export function ZenMedia({ media, processId, onReady }: { media: unknown; processId: string; onReady?: () => void }) {
  const t = useT();
  const preview = useMediaPreview();
  const descriptor = parseChatMedia(media);
  const kind = chatMediaKind(media);
  const filename = descriptor.filename && !/^archived-media:[a-f\d]{64}$/.test(descriptor.filename)
    ? descriptor.filename : t(MEDIA_NAMES[kind]);
  const opensAsImage = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(descriptor.mimeType ?? "");
  const { source, error, available, retry } = useChatMediaSource(descriptor, processId);
  const downloadTarget = source.startsWith("blob:") ? undefined : "_blank";
  return <figure class={`zen-media is-${kind}`}>
    {error ? <p class="zen-media-error" role="alert">{t("chat.media.loadFailed", { filename })} <button type="button" onClick={() => void retry()}>{t("chat.retry")}</button></p>
      : !available ? <p class="zen-media-error">{t("chat.media.unavailable", { filename })}</p>
      : source ? <>
        {kind === "image" && <a class="zen-media-image" href={source} download={opensAsImage ? undefined : filename} target={opensAsImage ? "_blank" : downloadTarget} rel="noreferrer"
          onClick={preview && opensAsImage ? (event) => {
            event.preventDefault();
            preview({ source, filename, description: descriptor.description || filename });
          } : undefined}><img src={source} alt={descriptor.description || filename} loading="lazy" onLoad={onReady} /></a>}
        {kind === "video" && <video controls preload="metadata" src={source} onLoadedMetadata={onReady} />}
        {kind === "audio" && <audio controls preload="metadata" src={source} />}
      </> : <LoadingState>{t("chat.media.loading", { filename })}</LoadingState>}
    <figcaption>
      {source ? <a href={source} download={filename} target={downloadTarget} rel="noreferrer">{filename}</a> : <span>{filename}</span>}
      <span>{formatChatMediaSize(descriptor.size)}</span>
    </figcaption>
    {descriptor.transcription && <details><summary>{t("chat.media.transcription")}</summary><p>{descriptor.transcription}</p></details>}
  </figure>;
}
