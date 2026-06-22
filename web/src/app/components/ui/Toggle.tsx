import { useState } from "preact/hooks";
import "./Toggle.css";

export type ToggleSize = "small" | "medium" | "large";
export type ToggleStatus = "none" | "error" | "success" | "info" | "warning";

export interface ToggleProps {
  on?: boolean;
  disabled?: boolean;
  size?: ToggleSize;
  label?: string;
  description?: string;
  status?: ToggleStatus;
  message?: string;
  onChange?: (on: boolean) => void;
}

const SIZE_CLASS: Record<ToggleSize, string> = {
  small: "gsv-tg-sm",
  medium: "gsv-tg-md",
  large: "gsv-tg-lg",
};

/** Toggle — ported from Toggle.dc.html. Self-toggling track + knob switch with
 *  optional label, field description and status row. */
export function Toggle(props: ToggleProps) {
  const {
    disabled = false,
    size = "medium",
    label = "RUN IN BACKGROUND",
    description = "",
    status = "none",
    message = "",
    onChange,
  } = props;

  const [onState, setOnState] = useState<boolean | undefined>(undefined);
  const on = onState === undefined ? props.on === true : onState;

  const rawStat = status && status !== "none" ? status : "";
  const statKey = rawStat === "warning" ? "warn" : rawStat;
  const hasStat = !!rawStat && message.length > 0;

  const rootClass = `gsv-tg ${SIZE_CLASS[size]}${on ? " is-on" : ""}${disabled ? " is-disabled" : ""}`;
  const fldClass = `gsv-tg-fld${hasStat ? ` is-${statKey}` : ""}`;

  const handleClick = () => {
    if (disabled) return;
    const nv = !on;
    setOnState(nv);
    onChange?.(nv);
  };

  return (
    <div class={fldClass}>
      {description ? <div class="gsv-tg-desc">{description}</div> : null}
      <div class={rootClass} onClick={handleClick}>
        <span class="gsv-tg-track">
          <span class="gsv-tg-knob" />
        </span>
        {label.length > 0 ? <span class="gsv-tg-label">{label}</span> : null}
      </div>
      {hasStat ? (
        <div class="gsv-tg-stat">
          <span class="gsv-tg-dot" />
          <span class="gsv-tg-msg">{message}</span>
        </div>
      ) : null}
    </div>
  );
}
