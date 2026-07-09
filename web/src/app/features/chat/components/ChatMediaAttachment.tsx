import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../../../components/ui/Icon";
import {
  chatMediaDescription,
  chatMediaDuration,
  chatMediaFilename,
  chatMediaKey,
  chatMediaKind,
  chatMediaMimeType,
  chatMediaSize,
  chatMediaSource,
  chatMediaTranscription,
  formatChatMediaDuration,
  formatChatMediaSize,
} from "../domain/media";
import { Hint } from "../../../components/ui/Tooltip";
import { useChatProcessMedia } from "../hooks";

type ChatMediaAttachmentProps = {
  media: unknown;
  processId: string;
};

function mediaIconName(kind: string): string {
  if (kind === "image") return "camera";
  if (kind === "audio") return "microphone";
  if (kind === "video") return "vimeo";
  return "file";
}

function mediaLabel(kind: string): string {
  if (kind === "image") return "Image";
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  return "Attachment";
}

function AudioPlayer({
  duration,
  source,
}: {
  duration: number | null;
  source: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [knownDuration, setKnownDuration] = useState(duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const max = knownDuration > 0 ? knownDuration : Math.max(currentTime, 1);
  const progress = max > 0 ? Math.min(100, Math.max(0, (currentTime / max) * 100)) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return undefined;
    }
    const syncDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setKnownDuration(audio.duration);
      }
    };
    const syncTime = () => setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const syncPlaying = () => setPlaying(!audio.paused && !audio.ended);
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("timeupdate", syncTime);
    audio.addEventListener("play", syncPlaying);
    audio.addEventListener("pause", syncPlaying);
    audio.addEventListener("ended", syncPlaying);
    return () => {
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("timeupdate", syncTime);
      audio.removeEventListener("play", syncPlaying);
      audio.removeEventListener("pause", syncPlaying);
      audio.removeEventListener("ended", syncPlaying);
    };
  }, [source]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused || audio.ended) {
      void audio.play().catch(() => setPlaying(false));
      return;
    }
    audio.pause();
  };

  const seek = (event: Event) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const nextTime = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(nextTime)) {
      return;
    }
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <div class="gsv-chat-audio-player">
      <audio ref={audioRef} preload="metadata" src={source} />
      <Hint text={playing ? "Pause audio" : "Play audio"}>
        <button type="button" aria-label={playing ? "Pause audio" : "Play audio"} onClick={toggle}>
          <Icon name={playing ? "circlePause" : "circlePlay"} family="doticons" size={12} />
        </button>
      </Hint>
      <input
        type="range"
        min="0"
        max={String(max)}
        step="0.01"
        value={String(Math.min(currentTime, max))}
        aria-label="Audio position"
        style={{ background: `linear-gradient(to right, var(--accent-bright) 0%, var(--accent-bright) ${progress}%, rgba(125, 120, 184, 0.28) ${progress}%, rgba(125, 120, 184, 0.28) 100%)` }}
        onInput={seek}
      />
      <span>{formatChatMediaDuration(currentTime)} / {formatChatMediaDuration(knownDuration)}</span>
    </div>
  );
}

export function ChatMediaAttachment({ media, processId }: ChatMediaAttachmentProps) {
  const key = chatMediaKey(media);
  const inlineSource = chatMediaSource(media);
  const mediaQuery = useChatProcessMedia({
    args: { key, mimeType: chatMediaMimeType(media), ...(processId ? { pid: processId } : {}) },
    enabled: !inlineSource && key.length > 0 && processId.length > 0,
  });
  const storedSource = mediaQuery.data?.dataUrl ?? "";
  const source = inlineSource || chatMediaSource(media, storedSource);
  const kind = chatMediaKind(media);
  const filename = chatMediaFilename(media);
  const mimeType = chatMediaMimeType(media);
  const size = formatChatMediaSize(chatMediaSize(media));
  const duration = chatMediaDuration(media);
  const durationLabel = formatChatMediaDuration(duration);
  const transcription = chatMediaTranscription(media);
  const description = chatMediaDescription(media);
  const meta = [mimeType, size, durationLabel].filter(Boolean).join(" · ");

  if (mediaQuery.isError) {
    return (
      <div class="gsv-chat-media is-error">
        <Icon name={mediaIconName(kind)} family="doticons" size={15} />
        <span>{mediaLabel(kind)} failed to load</span>
        <button type="button" onClick={() => void mediaQuery.refetch()}>RETRY</button>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <figure class="gsv-chat-media gsv-chat-media-image">
        {source ? <img src={source} alt={filename} loading="lazy" /> : <div class="gsv-chat-media-loading">Loading image...</div>}
        <figcaption>{filename}</figcaption>
        {description ? <p>{description}</p> : null}
      </figure>
    );
  }

  if (kind === "video") {
    return (
      <section class="gsv-chat-media gsv-chat-media-video">
        {source ? <video controls preload="metadata" src={source} /> : <div class="gsv-chat-media-loading">Loading video...</div>}
        <div><span>{filename}</span>{meta ? <small>{meta}</small> : null}</div>
      </section>
    );
  }

  if (kind === "audio") {
    return (
      <section class="gsv-chat-media gsv-chat-media-audio">
        <div class="gsv-chat-media-file-head">
          <Icon name="microphone" family="doticons" size={15} />
          <span>{filename}</span>
          {meta ? <small>{meta}</small> : null}
        </div>
        {source ? <AudioPlayer source={source} duration={duration} /> : <div class="gsv-chat-media-loading">Loading audio...</div>}
        {transcription ? (
          <details class="gsv-chat-media-transcript">
            <summary>TRANSCRIPTION</summary>
            <p>{transcription}</p>
          </details>
        ) : null}
      </section>
    );
  }

  const body = (
    <>
      <Icon name="file" family="doticons" size={15} />
      <span>
        <strong>{filename}</strong>
        {meta ? <small>{meta}</small> : null}
      </span>
    </>
  );
  return source ? (
    <a class="gsv-chat-media gsv-chat-media-file" href={source} download={filename} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <div class="gsv-chat-media gsv-chat-media-file is-loading">
      {body}
    </div>
  );
}
