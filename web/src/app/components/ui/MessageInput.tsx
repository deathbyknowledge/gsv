import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Hint, Tooltip } from "./Tooltip";
import { clipboardImageFiles } from "./messageInputClipboard";
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
  onFiles?: (files: FileList | readonly File[] | null) => void;
  onRemoveAttachment?: (id: string) => void;
  onSend?: (message: string) => void;
  onStop?: () => void;
  onVoiceClick?: () => void;
  voiceAction?: ComponentChildren;
  running?: boolean;
  voiceActive?: boolean;
  voiceAvailableWhenBusy?: boolean;
  voiceDisabled?: boolean;
  voiceTitle?: string;
}

/** Pixel size of the composer's floating icon buttons (tap target). */
const COMPOSER_ICON_SIZE = 26;

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
  voiceAction,
  running = false,
  voiceActive = false,
  voiceAvailableWhenBusy = false,
  voiceDisabled = false,
  voiceTitle = "Record voice",
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
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
  const handlePaste = (event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) => {
    if (!onFiles || disabled || busy) {
      return;
    }
    const imageFiles = clipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    onFiles(imageFiles);
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
            <span class="gsv-mi-chip gsv-sublabel" key={attachment.id}>
              <Icon name="file" family="doticons" size={13} />
              <span>
                <strong>{attachment.label}</strong>
                {attachment.meta ? <small>{attachment.meta}</small> : null}
              </span>
              {onRemoveAttachment ? (
                <Hint text="Remove attachment">
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.label}`}
                    disabled={disabled || busy}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <Icon name="close" family="doticons" size={11} />
                  </button>
                </Hint>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <form class="gsv-mi-bar" onSubmit={handleSubmit}>
        {onFiles ? (
          <>
            <Hint position="top-start" text="Attach files or images">
              <IconButton
                variant="floating"
                glyph="attach"
                size={COMPOSER_ICON_SIZE}
                ariaLabel="Attach files"
                disabled={disabled || busy}
                onClick={() => fileInputRef.current?.click()}
              />
            </Hint>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              disabled={disabled || busy}
              onChange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                onFiles(input.files);
                input.value = "";
              }}
            />
          </>
        ) : (
          <IconButton variant="floating" glyph="attach" size={COMPOSER_ICON_SIZE} disabled />
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
          onPaste={handlePaste}
        />
        {voiceAction}
        {onVoiceClick ? (
          <Hint position="top-end" text={voiceTitle}>
            <IconButton
              variant="floating"
              glyph="mic"
              size={COMPOSER_ICON_SIZE}
              className={`gsv-mi-voice${voiceActive ? " is-active" : ""}`}
              ariaLabel={voiceTitle}
              disabled={disabled || (!voiceAvailableWhenBusy && busy) || voiceDisabled}
              onClick={onVoiceClick}
            />
          </Hint>
        ) : (
          <IconButton variant="floating" glyph="mic" size={COMPOSER_ICON_SIZE} disabled />
        )}
        <Hint position="top-end" text={canStop ? "Stop the running agent" : "Send"}>
          <IconButton
            variant="floating"
            glyph={canStop ? "stop" : "send"}
            size={COMPOSER_ICON_SIZE}
            className={`gsv-mi-send${canStop ? " is-stop" : ""}`}
            ariaLabel={canStop ? "Stop run" : "Send message"}
            disabled={canStop ? false : !canSubmit}
            onClick={canStop ? onStop : submitDraft}
          />
        </Hint>
      </form>
      {user || cost ? (
        <div class="gsv-mi-meta gsv-sublabel">
          {cost ? (
            <span class="gsv-mi-cost-wrap">
              <Tooltip text={cost} position="top">
                <span class="gsv-mi-cost">$</span>
              </Tooltip>
            </span>
          ) : null}
          <span class="gsv-mi-user">{user}</span>
        </div>
      ) : null}
    </div>
  );
}
