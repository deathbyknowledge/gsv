import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { FileIcon, ImageIcon, MicIcon, VideoIcon } from "../../icons";
import { asNumber, asRecord, formatAttachmentDuration, formatAttachmentSize } from "../../view-helpers";
import { mediaFilename, mediaKind, mediaMimeType, mediaSourceKey } from "../../domain/media";

export function MediaAttachment(props: {
  media: unknown;
  source: string | null;
  error: string;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const kind = mediaKind(props.media);
  const key = mediaSourceKey(props.media);

  useEffect(() => {
    if (!props.source && !props.error && key) {
      props.onLoadMediaSource(props.media);
    }
  }, [key, props.error, props.media, props.onLoadMediaSource, props.source]);

  if (props.error) {
    return (
      <MediaLoadError
        icon={mediaKindIcon(kind)}
        label={`${mediaKindLabel(kind)} failed to load.`}
        error={props.error}
        onRetry={() => props.onRetryMediaSource(props.media)}
      />
    );
  }

  if (kind === "image") {
    return <ImageAttachment media={props.media} source={props.source} />;
  }
  if (kind === "video") {
    return <VideoAttachment media={props.media} source={props.source} />;
  }
  return <DocumentAttachment media={props.media} source={props.source} />;
}

function ImageAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Image";
  if (!props.source) {
    return <MediaLoading icon={<ImageIcon />} label="Loading image..." />;
  }
  return (
    <figure class="media-preview media-preview-image">
      <img src={props.source} alt={filename} loading="lazy" />
      <figcaption>{filename}</figcaption>
    </figure>
  );
}

function VideoAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Video";
  const duration = asNumber(asRecord(props.media)?.duration);
  if (!props.source) {
    return <MediaLoading icon={<VideoIcon />} label="Loading video..." />;
  }
  return (
    <section class="media-preview media-preview-video">
      <video controls preload="metadata" src={props.source} />
      <div class="media-preview-caption">
        <span>{filename}</span>
        {formatAttachmentDuration(duration) ? <time>{formatAttachmentDuration(duration)}</time> : null}
      </div>
    </section>
  );
}

function DocumentAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Attachment";
  const mimeType = mediaMimeType(props.media);
  const size = asNumber(asRecord(props.media)?.size);
  const sizeLabel = formatAttachmentSize(size);
  const label = [mimeType, sizeLabel].filter(Boolean).join(" - ");
  const content = (
    <>
      <span class="media-file-icon" aria-hidden="true"><FileIcon /></span>
      <span class="media-file-main">
        <span>{filename}</span>
        {label ? <span>{label}</span> : null}
      </span>
    </>
  );
  if (props.source) {
    return (
      <a class="media-file" href={props.source} download={filename} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return (
    <div class="media-file is-loading">
      {content}
    </div>
  );
}

function MediaLoading(props: { icon: ComponentChildren; label: string }) {
  return (
    <div class="media-loading">
      <span aria-hidden="true">{props.icon}</span>
      <span>{props.label}</span>
    </div>
  );
}

function MediaLoadError(props: { icon: ComponentChildren; label: string; error: string; onRetry(): void }) {
  return (
    <div class="media-loading is-error" title={props.error}>
      <span aria-hidden="true">{props.icon}</span>
      <span>{props.label}</span>
      <button type="button" onClick={props.onRetry}>Retry</button>
    </div>
  );
}

function mediaKindIcon(kind: string): ComponentChildren {
  if (kind === "image") return <ImageIcon />;
  if (kind === "audio") return <MicIcon />;
  if (kind === "video") return <VideoIcon />;
  return <FileIcon />;
}

function mediaKindLabel(kind: string): string {
  if (kind === "image") return "Image";
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  return "Attachment";
}
