import { useEffect, useState } from "preact/hooks";
import "./Checkbox.css";

export type CheckboxSize = "small" | "medium" | "large";
export type CheckboxStatus = "none" | "error" | "success" | "info" | "warning";

export interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  size?: CheckboxSize;
  label?: string;
  description?: string;
  status?: CheckboxStatus;
  message?: string;
  onChange?: (checked: boolean) => void;
}

const SIZE_CLASS: Record<CheckboxSize, string> = {
  small: "gsv-cb-sm",
  medium: "gsv-cb-md",
  large: "gsv-cb-lg",
};

/** Checkbox — ported from Checkbox.dc.html. Self-toggling box with check/dash
 *  fill, optional label, field description and status row. */
export function Checkbox(props: CheckboxProps) {
  const {
    indeterminate = false,
    disabled = false,
    size = "medium",
    label = "RUN IN BACKGROUND",
    description = "",
    status = "none",
    message = "",
    onChange,
  } = props;

  const [checkedState, setCheckedState] = useState<boolean | undefined>(undefined);
  const checked = checkedState === undefined ? !!props.checked : checkedState;
  const on = checked && !indeterminate;

  useEffect(() => {
    setCheckedState(undefined);
  }, [props.checked]);

  const rawStat = status && status !== "none" ? status : "";
  const statKey = rawStat === "warning" ? "warn" : rawStat;
  const hasStat = !!rawStat && message.length > 0;

  const rootClass = `gsv-cb ${SIZE_CLASS[size]}${on ? " is-on" : ""}${disabled ? " is-disabled" : ""}`;
  const fldClass = `gsv-cb-fld${hasStat ? ` is-${statKey}` : ""}`;

  const handleChange = (next: boolean) => {
    if (disabled) return;
    setCheckedState(next);
    onChange?.(next);
  };

  return (
    <div class={fldClass}>
      {description ? <div class="gsv-cb-desc">{description}</div> : null}
      <label class={rootClass}>
        <input
          aria-checked={indeterminate ? "mixed" : checked}
          checked={checked}
          class="gsv-cb-input"
          disabled={disabled}
          type="checkbox"
          onChange={(event) => handleChange((event.currentTarget as HTMLInputElement).checked)}
        />
        <span class="gsv-cb-box">
          {on ? <span class="gsv-cb-fill gsv-cb-on" /> : null}
          {indeterminate ? <span class="gsv-cb-fill gsv-cb-dash" /> : null}
        </span>
        {label.length > 0 ? <span class="gsv-cb-label">{label}</span> : null}
      </label>
      {hasStat ? (
        <div class="gsv-cb-stat">
          <span class="gsv-cb-dot" />
          <span class="gsv-cb-msg">{message}</span>
        </div>
      ) : null}
    </div>
  );
}
