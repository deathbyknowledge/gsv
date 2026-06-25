import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Icon } from "./Icon";
import "./MessageInput.css";

export type MessageInputAttachment = {
  id: string;
  label: string;
  meta?: string;
};

export interface MessageInputProps {
  actions?: ComponentChildren;
  attachments?: readonly MessageInputAttachment[];
  busy?: boolean;
  canSend?: boolean;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  user?: string;
  cost?: string;
  disabled?: boolean;
  focusKey?: number;
  onChange?: (value: string) => void;
  onFiles?: (files: FileList | null) => void;
  onRemoveAttachment?: (id: string) => void;
  onSend?: (message: string) => void;
  onStop?: () => void;
  onVoiceClick?: () => void;
  running?: boolean;
  voiceActive?: boolean;
  voiceAvailableWhenBusy?: boolean;
  voiceDisabled?: boolean;
  voiceTitle?: string;
}

function LeadGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="10" y="2" width="2" height="2" />
        <rect x="8" y="4" width="2" height="2" />
        <rect x="6" y="6" width="2" height="2" />
        <rect x="5" y="8" width="2" height="3" />
        <rect x="6" y="11" width="3" height="2" />
        <rect x="9" y="9" width="2" height="2" />
        <rect x="11" y="4" width="2" height="5" />
      </g>
    </svg>
  );
}

function MicrophoneGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="6" y="2" width="4" height="7" />
        <rect x="4" y="7" width="1" height="2" />
        <rect x="11" y="7" width="1" height="2" />
        <rect x="5" y="9" width="6" height="1" />
        <rect x="7" y="10" width="2" height="3" />
        <rect x="5" y="13" width="6" height="1" />
      </g>
    </svg>
  );
}

function SendGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16">
      <path d="M2 3 L14 8 L2 13 L4 8 Z" fill="currentColor" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <rect x="4" y="4" width="8" height="8" fill="currentColor" />
    </svg>
  );
}

/** MessageInput — autosizing composer with optional attachments and run control. */
export function MessageInput({
  actions,
  attachments = [],
  busy = false,
  canSend,
  placeholder = "Message...",
  value,
  defaultValue = "",
  user,
  cost,
  disabled = false,
  focusKey,
  onChange,
  onFiles,
  onRemoveAttachment,
  onSend,
  onStop,
  onVoiceClick,
  running = false,
  voiceActive = false,
  voiceAvailableWhenBusy = false,
  voiceDisabled = false,
  voiceTitle = "Record voice",
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [costTip, setCostTip] = useState(false);
  const draft = value ?? internalValue;
  const draftText = draft.trim();
  const hasAttachment = attachments.length > 0;
  const canSubmit = Boolean(onSend) && !disabled && !busy && (draftText.length > 0 || hasAttachment) && canSend !== false;
  const canStop = running && Boolean(onStop) && !busy;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const maxHeight = 164;
    textarea.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(18, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (focusKey === undefined || disabled) {
      return;
    }
    textareaRef.current?.focus();
  }, [disabled, focusKey]);

  const setDraft = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onChange?.(nextValue);
  };

  const toggleCost = (e: Event) => {
    e.stopPropagation();
    setCostTip((c) => !c);
  };
  const stop = (e: Event) => {
    e.stopPropagation();
  };
  const handleInput = (event: JSX.TargetedEvent<HTMLTextAreaElement>) => {
    setDraft(event.currentTarget.value);
  };
  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    submitDraft();
  };
  const submitDraft = () => {
    if (!canSubmit) {
      return;
    }
    onSend?.(draftText);
    setDraft("");
  };
  const handleSubmit = (event: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
  };

  return (
    <div class="gsv-mi">
      {attachments.length > 0 ? (
        <div class="gsv-mi-attachments">
          {attachments.map((attachment) => (
            <span class="gsv-mi-chip" key={attachment.id}>
              <Icon name="file" family="doticons" size={13} />
              <span>
                <strong>{attachment.label}</strong>
                {attachment.meta ? <small>{attachment.meta}</small> : null}
              </span>
              {onRemoveAttachment ? (
                <button
                  type="button"
                  aria-label={`Remove ${attachment.label}`}
                  title="Remove attachment"
                  disabled={disabled || busy}
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  <Icon name="close" family="doticons" size={11} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <form class="gsv-mi-bar" onSubmit={handleSubmit}>
        {onFiles ? (
          <label class="gsv-mi-icon gsv-mi-file" title="Attach files" aria-label="Attach files">
            <LeadGlyph />
            <input
              type="file"
              multiple
              disabled={disabled || busy}
              onChange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                onFiles(input.files);
                input.value = "";
              }}
            />
          </label>
        ) : (
          <span class="gsv-mi-icon" aria-hidden="true">
            <LeadGlyph />
          </span>
        )}
        {actions}
        <textarea
          ref={textareaRef}
          class="gsv-mi-input"
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          spellcheck={true}
          value={draft}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        {onVoiceClick ? (
          <button
            type="button"
            class={`gsv-mi-icon gsv-mi-voice${voiceActive ? " is-active" : ""}`}
            disabled={disabled || (!voiceAvailableWhenBusy && busy) || voiceDisabled}
            aria-label={voiceTitle}
            title={voiceTitle}
            onClick={onVoiceClick}
          >
            <MicrophoneGlyph />
          </button>
        ) : (
          <span class="gsv-mi-icon" aria-hidden="true">
            <MicrophoneGlyph />
          </span>
        )}
        <button
          class={`gsv-mi-send${canStop ? " is-stop" : ""}`}
          type={canStop ? "button" : "submit"}
          disabled={canStop ? false : !canSubmit}
          aria-label={canStop ? "Stop run" : "Send message"}
          title={canStop ? "Stop run" : "Send message"}
          onClick={canStop ? onStop : undefined}
        >
          {canStop ? <StopGlyph /> : <SendGlyph />}
        </button>
      </form>
      {user || cost ? (
        <div class="gsv-mi-meta">
          <span class="gsv-mi-user">{user}</span>
          {cost ? (
            <span class="gsv-mi-cost-wrap">
              <button type="button" class="gsv-mi-cost" onClick={toggleCost}>
                {cost}
              </button>
              {costTip ? (
                <div class="gsv-mi-tip" onClick={stop}>
                  <div class="gsv-mi-tip-title">CURRENT SESSION COST</div>
                  <div class="gsv-mi-tip-link">learn more</div>
                </div>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
