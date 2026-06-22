import { useState } from "preact/hooks";
import "./TextArea.css";

export type TextAreaSize = "small" | "medium" | "large";
export type TextAreaStatus = "none" | "error" | "success" | "info" | "warning";
export type TextAreaRequirement = "none" | "required" | "optional";

export interface TextAreaProps {
  value?: string;
  placeholder?: string;
  label?: string;
  description?: string;
  size?: TextAreaSize;
  rows?: number;
  status?: TextAreaStatus;
  message?: string;
  requirement?: TextAreaRequirement;
  disabled?: boolean;
  readonly?: boolean;
  maxLength?: number;
  onChange?: (value: string) => void;
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
    description = "",
    size = "medium",
    rows = 3,
    status = "none",
    message = "",
    requirement = "none",
    disabled = false,
    readonly = false,
    maxLength = 0,
    onChange,
  } = props;

  const [val, setVal] = useState<string | undefined>(undefined);

  const value = val !== undefined ? val : props.value ?? "";

  const rawStatus = status && status !== "none" ? status : "";
  const statusKey = rawStatus === "warning" ? "warn" : rawStatus;
  const hasStatusMsg = !!rawStatus && message.length > 0;

  const showCounter = maxLength > 0 && !hasStatusMsg;
  const counterText = maxLength > 0 ? `${String(value).length} / ${maxLength}` : "";

  const req = requirement && requirement !== "none" ? requirement : "";
  const hasLabelRow = label.length > 0 || !!req;
  const hasDesc = description.length > 0;
  const hasStatusRow = hasStatusMsg || showCounter;

  const rootClass = `gsv-ta ${SIZE_CLASS[size]}${rawStatus ? ` is-${statusKey}` : ""}`;
  const boxClass = `gsv-ta-box ${disabled ? "is-disabled" : readonly ? "is-readonly" : ""}`.trim();

  const emit = (next: string) => {
    setVal(next);
    onChange?.(next);
  };

  return (
    <div class={rootClass}>
      {hasLabelRow ? (
        <div class="gsv-ta-labelrow">
          <span class="gsv-ta-label">
            {label}
            {req ? <span class="gsv-ta-req"> {req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          </span>
        </div>
      ) : null}
      {hasDesc ? <div class="gsv-ta-desc">{description}</div> : null}
      <textarea
        class={boxClass}
        value={value}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        readOnly={readonly}
        spellcheck={false}
        onInput={(e) => emit((e.target as HTMLTextAreaElement).value)}
      />
      {hasStatusRow ? (
        <div class="gsv-ta-statusrow">
          {hasStatusMsg ? (
            <span class="gsv-ta-right">
              <span class="gsv-ta-dot" />
              <span class="gsv-ta-msg">{message}</span>
            </span>
          ) : null}
          {showCounter ? <span class="gsv-ta-counter">{counterText}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
