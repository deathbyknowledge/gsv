import { LoadingState } from "../../../components/ui/Spinner";
import { chatMediaKind, formatChatMediaSize, parseChatMedia } from "../../../services/chat/domain/media";
import { useChatMediaSource, useMediaObjectUrl } from "../../../services/chat/hooks/useChatMediaSource";
import type { ZenAttachment } from "./zenAttachments";

export function ZenDraftAttachment({ attachment, onRemove, disabled }: { attachment: ZenAttachment; onRemove: () => void; disabled?: boolean }) {
  const image = attachment.type === "image";
  const source = useMediaObjectUrl(image ? attachment.body : undefined);
  return <li class="zen-draft-attachment">
    {source && <img src={source} alt="" />}
    <span class="file-name">{attachment.filename}<small>{formatChatMediaSize(attachment.body.size)}</small></span>
    <button type="button" onClick={onRemove} disabled={disabled} aria-label={`Remove ${attachment.filename}`}>×</button>
  </li>;
}

export function ZenMedia({ media, processId, onReady }: { media: unknown; processId: string; onReady?: () => void }) {
  const descriptor = parseChatMedia(media);
  const kind = chatMediaKind(media);
  const filename = descriptor.filename && !/^archived-media:[a-f\d]{64}$/.test(descriptor.filename)
    ? descriptor.filename : kind === "document" ? "attachment" : kind;
  const opensAsImage = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(descriptor.mimeType ?? "");
  const { source, error, available, retry } = useChatMediaSource(descriptor, processId);
  return <figure class={`zen-media is-${kind}`}>
    {error ? <p class="zen-media-error" role="alert">Could not load {filename}. <button type="button" onClick={() => void retry()}>retry</button></p>
      : !available ? <p class="zen-media-error">{filename} is unavailable.</p>
      : source ? <>
        {kind === "image" && <a class="zen-media-image" href={source} download={opensAsImage ? undefined : filename} target="_blank" rel="noreferrer"><img src={source} alt={descriptor.description || filename} loading="lazy" onLoad={onReady} /></a>}
        {kind === "video" && <video controls preload="metadata" src={source} onLoadedMetadata={onReady} />}
        {kind === "audio" && <audio controls preload="metadata" src={source} />}
      </> : <LoadingState>Loading {filename}…</LoadingState>}
    <figcaption>
      {source ? <a href={source} download={filename} target="_blank" rel="noreferrer">{filename}</a> : <span>{filename}</span>}
      <span>{formatChatMediaSize(descriptor.size)}</span>
    </figcaption>
    {descriptor.transcription && <details><summary>transcription</summary><p>{descriptor.transcription}</p></details>}
  </figure>;
}
