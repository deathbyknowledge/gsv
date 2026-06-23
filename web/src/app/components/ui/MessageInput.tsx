import { useState } from "preact/hooks";
import type { JSX } from "preact";
import "./MessageInput.css";

export interface MessageInputProps {
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  user?: string;
  cost?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  onSend?: (message: string) => void;
}

/** MessageInput — chat input bar with attachment / text / voice / send controls. */
export function MessageInput({
  placeholder = "Message...",
  value,
  defaultValue = "",
  user,
  cost,
  disabled = false,
  onChange,
  onSend,
}: MessageInputProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [costTip, setCostTip] = useState(false);
  const draft = value ?? internalValue;

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
  const handleInput = (event: JSX.TargetedEvent<HTMLInputElement>) => {
    setDraft(event.currentTarget.value);
  };
  const handleSubmit = (event: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || disabled) {
      return;
    }
    onSend?.(message);
    setDraft("");
  };

  return (
    <div class="gsv-mi">
      <form class="gsv-mi-bar" onSubmit={handleSubmit}>
        <span class="gsv-mi-icon">
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
        </span>
        <input
          class="gsv-mi-input"
          disabled={disabled}
          placeholder={placeholder}
          value={draft}
          onInput={handleInput}
        />
        <span class="gsv-mi-icon">
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
        </span>
        <button class="gsv-mi-send" type="submit" disabled={disabled || draft.trim().length === 0} aria-label="Send message">
          <svg width="17" height="17" viewBox="0 0 16 16">
            <path d="M2 3 L14 8 L2 13 L4 8 Z" fill="currentColor" />
          </svg>
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
