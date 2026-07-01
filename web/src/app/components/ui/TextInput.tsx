import type { ComponentChildren, JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { InfoTip } from "./InfoTip";
import "./TextInput.css";

export type TextInputSize = "small" | "medium" | "large";
export type TextInputStatus = "none" | "error" | "success" | "info" | "warning";
export type TextInputRequirement = "none" | "required" | "optional";

export interface TextInputProps {
  value?: string;
  placeholder?: string;
  label?: string;
  info?: string;
  description?: string;
  size?: TextInputSize;
  status?: TextInputStatus;
  message?: string;
  requirement?: TextInputRequirement;
  disabled?: boolean;
  readonly?: boolean;
  /** Leading affix — a short string, or any node (e.g. an Icon) for callers
   *  like Search that need a glyph. Rendered before the input. */
  prefix?: ComponentChildren;
  suffix?: string;
  clearable?: boolean;
  type?: "text" | "password";
  maxLength?: number;
  onChange?: (value: string) => void;
  /** Extra attributes spread onto the inner <input> (autoComplete, name,
   *  data-* focus markers, etc.) — does not override the managed attrs. */
  inputProps?: JSX.IntrinsicElements["input"] & Record<`data-${string}`, string | number | boolean>;
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
    info = "",
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
    inputProps,
  } = props;

  const fieldId = useId();
  const [internalValue, setInternalValue] = useState(props.value ?? "");
  const [revealed, setRevealed] = useState(false);

  const controlled = props.value !== undefined;
  const value = controlled ? props.value ?? "" : internalValue;
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

  const describedBy =
    [description ? `${fieldId}-desc` : "", hasStatusMsg ? `${fieldId}-msg` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  const rootClass = `gsv-fld gsv-ti ${SIZE_CLASS[size]}${rawStatus ? ` is-${statusKey}` : ""}`;
  const wrapClass = `gsv-ti-wrap ${disabled ? "is-disabled" : readonly ? "is-readonly" : ""}`.trim();

  const emit = (next: string) => {
    if (!controlled) {
      setInternalValue(next);
    }
    onChange?.(next);
  };

  return (
    <div class={rootClass}>
      {hasLabelRow ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t gsv-sublabel" id={`${fieldId}-label`}>
            {label}
            {req ? <span class="gsv-fld-req gsv-sublabel">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          </span>
          {info ? <InfoTip text={info} /> : null}
        </div>
      ) : null}
      {description ? <div class="gsv-fld-desc gsv-sublabel" id={`${fieldId}-desc`}>{description}</div> : null}
      <div class={wrapClass}>
        {prefix ? <span class="gsv-ti-affix gsv-label">{prefix}</span> : null}
        <input
          {...inputProps}
          class="gsv-ti-input"
          id={fieldId}
          type={isPassword && !revealed ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readonly}
          aria-labelledby={hasLabelRow && label.length > 0 ? `${fieldId}-label` : undefined}
          aria-describedby={describedBy}
          aria-invalid={status === "error" ? true : undefined}
          onInput={(e) => emit((e.target as HTMLInputElement).value)}
        />
        {showClear ? (
          <button type="button" class="gsv-ti-x" aria-label="Clear input" onClick={() => emit("")}>
            <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="square">
              <line x1="3" y1="3" x2="13" y2="13" />
              <line x1="13" y1="3" x2="3" y2="13" />
            </svg>
          </button>
        ) : null}
        {isPassword ? (
          <button
            type="button"
            class="gsv-ti-btn gsv-sublabel"
            disabled={disabled}
            aria-pressed={revealed}
            aria-label={revealed ? "Hide password" : "Show password"}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? "HIDE" : "SHOW"}
          </button>
        ) : null}
        {suffix ? <span class="gsv-ti-affix gsv-label">{suffix}</span> : null}
      </div>
      {hasStatusRow ? (
        <div class="gsv-fld-stat" style={showCounter ? { justifyContent: "flex-end" } : undefined}>
          {hasStatusMsg ? (
            <>
              <span class="gsv-fld-dot" />
              <span class="gsv-fld-msg gsv-sublabel" id={`${fieldId}-msg`}>{message}</span>
            </>
          ) : null}
          {showCounter ? <span class="gsv-ti-counter gsv-sublabel">{counterText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
