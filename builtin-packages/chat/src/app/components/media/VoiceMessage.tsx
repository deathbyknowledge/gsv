import { useEffect, useRef, useState } from "preact/hooks";
import { MicIcon, PauseIcon, PlayIcon } from "../../icons";
import { asNumber, asRecord, asString } from "../../view-helpers";
import { mediaSourceKey } from "../../domain/media";

export function VoiceMessage(props: {
  media: unknown;
  source: string | null;
  error: string;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const key = mediaSourceKey(props.media);
  const record = asRecord(props.media);
  const duration = asNumber(record?.duration);
  const transcription = asString(record?.transcription)?.trim() || "";

  useEffect(() => {
    if (!props.source && !props.error && key) {
      props.onLoadMediaSource(props.media);
    }
  }, [key, props.error, props.media, props.onLoadMediaSource, props.source]);

  return (
    <section class="voice-message">
      <div class="voice-message-player">
        <span class="voice-message-icon" aria-hidden="true"><MicIcon /></span>
        <div class="voice-message-main">
          {props.error ? (
            <div class="voice-message-loading is-error" title={props.error}>
              <span>Audio failed to load.</span>
              <button type="button" onClick={() => props.onRetryMediaSource(props.media)}>Retry</button>
            </div>
          ) : props.source ? (
            <VoiceAudioPlayer source={props.source} duration={duration} />
          ) : (
            <div class="voice-message-loading">Loading audio...</div>
          )}
        </div>
      </div>
      {transcription ? (
        <details class="voice-transcript">
          <summary>Transcription</summary>
          <p>{transcription}</p>
        </details>
      ) : null}
    </section>
  );
}

export function VoiceAudioPlayer(props: { source: string; duration: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() => normalizeAudioTime(props.duration));
  const [isPlaying, setIsPlaying] = useState(false);
  const max = duration > 0 ? duration : Math.max(currentTime, 1);
  const progress = max > 0 ? Math.min(100, Math.max(0, (currentTime / max) * 100)) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const syncDuration = () => {
      const nextDuration = normalizeAudioTime(audio.duration) || normalizeAudioTime(props.duration);
      setDuration(nextDuration);
    };
    const syncTime = () => {
      setCurrentTime(normalizeAudioTime(audio.currentTime));
    };
    const syncPlaying = () => {
      setIsPlaying(!audio.paused && !audio.ended);
    };

    setCurrentTime(0);
    setIsPlaying(false);
    syncDuration();
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
  }, [props.duration, props.source]);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused || audio.ended) {
      try {
        await audio.play();
      } catch {
        setIsPlaying(false);
      }
      return;
    }
    audio.pause();
  }

  function seek(event: Event): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const nextTime = Number(input.value);
    if (!Number.isFinite(nextTime)) {
      return;
    }
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  return (
    <div class="voice-audio-player">
      <audio class="voice-audio-native" ref={audioRef} preload="metadata" src={props.source} />
      <button
        type="button"
        class="voice-audio-button"
        title={isPlaying ? "Pause voice message" : "Play voice message"}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
        onClick={() => void togglePlayback()}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <input
        class="voice-audio-range"
        type="range"
        min="0"
        max={String(max)}
        step="0.01"
        value={String(Math.min(currentTime, max))}
        aria-label="Voice message position"
        style={{ background: `linear-gradient(to right, var(--blue) 0%, var(--blue) ${progress}%, rgba(31, 92, 153, 0.14) ${progress}%, rgba(31, 92, 153, 0.14) 100%)` }}
        onInput={seek}
      />
      <span class="voice-audio-time">{formatAudioPlayerTime(currentTime)} / {formatAudioPlayerTime(duration)}</span>
    </div>
  );
}

function normalizeAudioTime(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatAudioPlayerTime(value: number): string {
  const totalSeconds = Math.floor(normalizeAudioTime(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
