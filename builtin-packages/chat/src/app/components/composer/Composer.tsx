import { useEffect, useRef } from "preact/hooks";
import type { Attachment, VoiceRecordingState } from "../../types";
import { MicIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "../../icons";
import { formatAttachmentDuration } from "../../view-helpers";
import { VoiceAudioPlayer } from "../media/VoiceMessage";

export function Composer(props: {
  value: string;
  attachments: Attachment[];
  disabled: boolean;
  canSend: boolean;
  canStop: boolean;
  stopBusy: boolean;
  voice: VoiceRecordingState;
  canRecord: boolean;
  onValueChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onFiles(files: FileList | null): void;
  onRemoveAttachment(index: number): void;
  onStartVoice(): void;
  onStopVoice(): void;
  onCancelVoice(): void;
  onClearVoiceError(): void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const actionLabel = props.canStop ? (props.stopBusy ? "Stopping..." : "Stop") : "Send";
  const voiceActive = props.voice.status !== "idle";
  const showVoicePanel = voiceActive || Boolean(props.voice.error);
  const voiceLabel = labelForVoiceState(props.voice);
  const voiceElapsed = formatAttachmentDuration(props.voice.elapsedMs / 1000) || "0:00";
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const maxHeight = 176;
    textarea.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(42, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [props.value]);
  return (
    <form class="composer" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
      {props.attachments.length > 0 ? (
        <div class="attachment-list">
          {props.attachments.map((attachment, index) => (
            attachment.type === "audio" ? (
              <DraftVoiceAttachment
                key={`${attachment.filename ?? "voice"}:${index}`}
                attachment={attachment}
                onRemove={() => props.onRemoveAttachment(index)}
              />
            ) : (
              <div class="attachment-chip" key={`${attachment.filename ?? "file"}:${index}`}>
                <span class="attachment-name">{attachment.filename || "attachment"}</span>
                {attachment.duration ? <span class="attachment-duration">{formatAttachmentDuration(attachment.duration)}</span> : null}
                <button type="button" aria-label="Remove attachment" title="Remove attachment" onClick={() => props.onRemoveAttachment(index)}>x</button>
              </div>
            )
          ))}
        </div>
      ) : null}
      {showVoicePanel ? (
        <div class={"voice-panel is-" + props.voice.status}>
          <div class="voice-state">
            <span class="voice-dot" aria-hidden="true" />
            <span>{voiceLabel}</span>
            {props.voice.status === "idle" && props.voice.error ? null : <time>{voiceElapsed}</time>}
          </div>
          {props.voice.error ? <span class="voice-error">{props.voice.error}</span> : null}
          <div class="voice-actions">
            {props.voice.status === "recording" ? (
              <button type="button" class="icon-button small" title="Finish recording" aria-label="Finish recording" onClick={props.onStopVoice}>
                <StopIcon />
              </button>
            ) : null}
            {props.voice.status === "requesting" || props.voice.status === "recording" ? (
              <button type="button" class="icon-button small" title="Cancel recording" aria-label="Cancel recording" onClick={props.onCancelVoice}>
                <XIcon />
              </button>
            ) : null}
            {props.voice.status === "idle" && props.voice.error ? (
              <button type="button" class="icon-button small" title="Dismiss" aria-label="Dismiss voice error" onClick={props.onClearVoiceError}>
                <XIcon />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div class="composer-shell">
        <label class="icon-button attach" title="Attach files" aria-label="Attach files">
          <PaperclipIcon />
          <input type="file" multiple disabled={props.disabled} onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            props.onFiles(input.files);
            input.value = "";
          }} />
        </label>
        <button
          class={"icon-button voice" + (props.voice.status === "recording" ? " is-recording" : "")}
          type="button"
          title={props.voice.status === "recording" ? "Recording voice" : "Record voice"}
          aria-label={props.voice.status === "recording" ? "Recording voice" : "Record voice"}
          disabled={props.disabled || !props.canRecord || voiceActive}
          onClick={props.onStartVoice}
        >
          <MicIcon />
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={props.value}
          disabled={props.disabled}
          placeholder="Ask, continue the thread, or describe work for this process."
          onInput={(event) => props.onValueChange((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (props.canSend) {
                props.onSubmit();
              }
            }
          }}
        />
        <button
          class={props.canStop ? "composer-action icon-button danger" : "composer-action icon-button"}
          type={props.canStop ? "button" : "submit"}
          title={actionLabel}
          aria-label={actionLabel}
          disabled={props.canStop ? props.stopBusy : !props.canSend}
          onClick={props.canStop ? props.onStop : undefined}
        >
          {props.canStop ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </form>
  );
}

function DraftVoiceAttachment(props: { attachment: Attachment; onRemove(): void }) {
  const source = props.attachment.previewUrl || props.attachment.data;
  return (
    <div class="attachment-chip is-audio" title={props.attachment.filename || "Voice recording"}>
      <span class="voice-message-icon" aria-hidden="true"><MicIcon /></span>
      <div class="attachment-voice-main">
        {source ? (
          <VoiceAudioPlayer source={source} duration={props.attachment.duration ?? null} />
        ) : (
          <div class="voice-message-loading">Loading audio...</div>
        )}
      </div>
      <button type="button" aria-label="Remove voice recording" title="Remove voice recording" onClick={props.onRemove}>
        <XIcon />
      </button>
    </div>
  );
}

function labelForVoiceState(state: VoiceRecordingState): string {
  if (state.status === "requesting") return "Microphone";
  if (state.status === "recording") return "Recording";
  if (state.status === "processing") return "Preparing voice";
  if (state.error) return "Voice input";
  return "Voice input";
}
