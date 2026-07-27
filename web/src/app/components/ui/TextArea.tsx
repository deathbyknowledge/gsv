import type { JSX } from "preact";
import { useId, useState } from "preact/hooks";
import { InfoTip } from "./InfoTip";
import "./TextArea.css";

export type TextAreaSize = "small" | "medium" | "large";
export type TextAreaStatus = "none" | "error" | "success" | "info" | "warning";
export type TextAreaRequirement = "none" | "required" | "optional";

export interface TextAreaProps {
  value?: string;
  placeholder?: string;
  label?: string;
  info?: string;
  description?: string;
  size?: TextAreaSize;
  rows?: number;
  status?: TextAreaStatus;
  message?: string;
  requirement?: TextAreaRequirement;
  /** When true, reveal the required-empty error immediately (e.g. on a submit
   *  attempt) even if the field hasn't been blurred yet. */
  forceValidate?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  maxLength?: number;
  onChange?: (value: string) => void;
  /** Extra attributes spread onto the inner <textarea> (onKeyDown, ref,
   *  aria-* markers, etc.) — does not override the managed attrs. */
  textareaProps?: JSX.IntrinsicElements["textarea"] & Record<`data-${string}`, string | number | boolean>;
}

const SIZE_CLASS: Record<TextAreaSize, string> = {
  small: "gsv-ta-sm",
  medium: "gsv-ta-md",
  large: "gsv-ta-lg",
};

/** TextArea — ported from TextArea.dc.html. Multi-line field with optional
 *  label row, description, status row + counter. */
export function TextArea(props: TextAreaProps) {
  const {
    placeholder = "What is this agent for? A line or two.",
    label = "DESCRIPTION",
    info = "",
    description = "",
    size = "medium",
    rows = 3,
    status = "none",
    message = "",
    requirement = "none",
    forceValidate = false,
    disabled = false,
    readonly = false,
    maxLength = 0,
    onChange,
    textareaProps,
  } = props;

  const fieldId = useId();
  const [internalValue, setInternalValue] = useState(props.value ?? "");
  const [blurred, setBlurred] = useState(false);
  const controlled = props.value !== undefined;

  const value = controlled ? props.value ?? "" : internalValue;

  // Systemic required enforcement (see TextInput): a required field left empty
  // shows "REQUIRED" once blurred or on a forced submit-time validation; a
  // caller-supplied `status` always wins.
  const requiredEmpty = requirement === "required" && String(value).trim().length === 0;
  const showRequiredError = requiredEmpty && (blurred || forceValidate);
  const effectiveStatus: TextAreaStatus =
    status !== "none" ? status : showRequiredError ? "error" : "none";
  const effectiveMessage =
    status !== "none" ? message : showRequiredError ? "REQUIRED" : message;

  const rawStatus = effectiveStatus && effectiveStatus !== "none" ? effectiveStatus : "";
  const statusKey = rawStatus === "warning" ? "warn" : rawStatus;
  const hasStatusMsg = !!rawStatus && effectiveMessage.length > 0;

  const showCounter = maxLength > 0 && !hasStatusMsg;
  const counterText = maxLength > 0 ? `${String(value).length} / ${maxLength}` : "";

  const req = requirement && requirement !== "none" ? requirement : "";
  const hasLabelRow = label.length > 0 || !!req;
  const hasDesc = description.length > 0;
  const hasStatusRow = hasStatusMsg || showCounter;

  const describedBy =
    [hasDesc ? `${fieldId}-desc` : "", hasStatusMsg ? `${fieldId}-msg` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  const rootClass = `gsv-ta ${SIZE_CLASS[size]}${rawStatus ? ` is-${statusKey}` : ""}`;
  const boxClass = `gsv-ta-box ${disabled ? "is-disabled" : readonly ? "is-readonly" : ""}`.trim();

  const emit = (next: string) => {
    if (!controlled) {
      setInternalValue(next);
    }
    onChange?.(next);
  };

  return (
    <div class={rootClass}>
      {hasLabelRow ? (
        <div class="gsv-ta-labelrow">
          <span class="gsv-ta-label gsv-sublabel" id={`${fieldId}-label`}>
            {label}
            {req ? <span class="gsv-ta-req"> {req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          </span>
          {info ? <InfoTip text={info} /> : null}
        </div>
      ) : null}
      {hasDesc ? <div class="gsv-ta-desc gsv-paragraph-small" id={`${fieldId}-desc`}>{description}</div> : null}
      <textarea
        {...textareaProps}
        class={boxClass}
        id={fieldId}
        value={value}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        readOnly={readonly}
        spellcheck={false}
        aria-labelledby={hasLabelRow && label.length > 0 ? `${fieldId}-label` : undefined}
        aria-describedby={describedBy}
        aria-invalid={effectiveStatus === "error" ? true : undefined}
        onInput={(e) => emit((e.target as HTMLTextAreaElement).value)}
        onBlur={(e) => {
          setBlurred(true);
          textareaProps?.onBlur?.(e);
        }}
      />
      {hasStatusRow ? (
        <div class="gsv-ta-statusrow">
          {hasStatusMsg ? (
            <span class="gsv-ta-right">
              <span class="gsv-ta-dot" />
              <span class="gsv-ta-msg gsv-sublabel" id={`${fieldId}-msg`}>{effectiveMessage}</span>
            </span>
          ) : null}
          {showCounter ? <span class="gsv-ta-counter gsv-sublabel">{counterText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
