import { useState } from "preact/hooks";
import "./TextInput.css";

export type TextInputSize = "small" | "medium" | "large";
export type TextInputStatus = "none" | "error" | "success" | "info" | "warning";
export type TextInputRequirement = "none" | "required" | "optional";

export interface TextInputProps {
  value?: string;
  placeholder?: string;
  label?: string;
  description?: string;
  size?: TextInputSize;
  status?: TextInputStatus;
  message?: string;
  requirement?: TextInputRequirement;
  disabled?: boolean;
  readonly?: boolean;
  prefix?: string;
  suffix?: string;
  clearable?: boolean;
  type?: "text" | "password";
  maxLength?: number;
  onChange?: (value: string) => void;
}

const SIZE_CLASS: Record<TextInputSize, string> = {
  small: "gsv-ti-sm",
  medium: "gsv-ti-md",
  large: "gsv-ti-lg",
};

/** TextInput — ported from TextInput.dc.html. Full bordered field with optional
 *  label row, description, status row + counter, prefix/suffix, clear, reveal. */
export function TextInput(props: TextInputProps) {
  const {
    placeholder = "e.g. PERSONAL AGENT",
    label = "ROLE",
    description = "",
    size = "medium",
    status = "none",
    message = "",
    requirement = "none",
    disabled = false,
    readonly = false,
    prefix = "",
    suffix = "",
    clearable = false,
    type = "text",
    maxLength = 0,
    onChange,
  } = props;

  const [val, setVal] = useState<string | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);

  const value = val !== undefined ? val : props.value ?? "";
  const hasValue = String(value).length > 0;

  const rawStatus = status && status !== "none" ? status : "";
  const statusKey = rawStatus === "warning" ? "warn" : rawStatus;
  const hasStatusMsg = !!rawStatus && message.length > 0;

  const showCounter = maxLength > 0 && !hasStatusMsg;
  const counterText = maxLength > 0 ? `${String(value).length} / ${maxLength}` : "";

  const req = requirement && requirement !== "none" ? requirement : "";
  const isPassword = type === "password";
  const showClear = clearable && hasValue && !disabled && !readonly;
  const hasLabelRow = label.length > 0 || !!req;
  const hasStatusRow = hasStatusMsg || showCounter;

  const rootClass = `gsv-ti ${SIZE_CLASS[size]}${rawStatus ? ` is-${statusKey}` : ""}`;
  const wrapClass = `gsv-ti-wrap ${disabled ? "is-disabled" : readonly ? "is-readonly" : ""}`.trim();

  const emit = (next: string) => {
    setVal(next);
    onChange?.(next);
  };

  return (
    <div class={rootClass}>
      {hasLabelRow ? (
        <div class="gsv-ti-labelrow">
          <span class="gsv-ti-label">
            {label}
            {req ? <span class="gsv-ti-req"> {req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          </span>
        </div>
      ) : null}
      {description ? <div class="gsv-ti-desc">{description}</div> : null}
      <div class={wrapClass}>
        {prefix ? <span class="gsv-ti-affix">{prefix}</span> : null}
        <input
          class="gsv-ti-input"
          type={isPassword && !revealed ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readonly}
          onInput={(e) => emit((e.target as HTMLInputElement).value)}
        />
        {showClear ? (
          <button type="button" class="gsv-ti-x" aria-label="Clear input" onClick={() => emit("")}>
            <svg width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        ) : null}
        {isPassword ? (
          <button
            type="button"
            class="gsv-ti-btn"
            disabled={disabled}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? "HIDE" : "SHOW"}
          </button>
        ) : null}
        {suffix ? <span class="gsv-ti-affix">{suffix}</span> : null}
      </div>
      {hasStatusRow ? (
        <div class="gsv-ti-statusrow">
          {hasStatusMsg ? (
            <span class="gsv-ti-right">
              <span class="gsv-ti-dot" />
              <span class="gsv-ti-msg">{message}</span>
            </span>
          ) : (
            <span />
          )}
          {showCounter ? <span class="gsv-ti-counter">{counterText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
