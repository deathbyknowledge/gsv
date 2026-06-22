import { useState } from "preact/hooks";
import "./Counter.css";

export type CounterSize = "small" | "medium" | "large";
export type CounterRequirement = "none" | "required" | "optional";
export type CounterStatus = "none" | "error" | "success" | "info" | "warning";

export interface CounterProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  description?: string;
  requirement?: CounterRequirement;
  status?: CounterStatus;
  message?: string;
  size?: CounterSize;
  disabled?: boolean;
  onChange?: (value: number) => void;
}

const SIZE_CLASS: Record<CounterSize, string> = {
  small: "gsv-st-sm",
  medium: "gsv-st-md",
  large: "gsv-st-lg",
};

/** Counter — ported from Counter.dc.html. −/+ stepper for a numeric value with
 *  optional unit, label / desc / status field chrome. */
export function Counter(props: CounterProps) {
  const {
    min = 0,
    max = 100,
    step = 1,
    unit = "",
    label = "",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    size = "medium",
    disabled = false,
    onChange,
  } = props;

  const [stateVal, setStateVal] = useState<number | undefined>(undefined);

  const cur = stateVal === undefined ? props.value ?? 1 : stateVal;
  const val = Math.max(min, Math.min(max, isNaN(cur) ? 0 : cur));

  const set = (v: number) => {
    v = Math.max(min, Math.min(max, v));
    setStateVal(v);
    onChange?.(v);
  };

  const req = requirement && requirement !== "none" ? requirement : "";
  const rawStat = status && status !== "none" ? status : "";
  const statKey = rawStat === "warning" ? "warn" : rawStat;
  const hasStat = !!rawStat && message.length > 0;

  const rootClass = ("gsv-st " + SIZE_CLASS[size] + (disabled ? " is-disabled" : "")).trim();
  const fldClass = "gsv-fld" + (hasStat ? " is-" + statKey : "");
  const hasFldLabel = label.length > 0 || !!req;
  const display = val + (unit ? unit : "");

  const dec = disabled ? undefined : () => set(val - step);
  const inc = disabled ? undefined : () => set(val + step);

  return (
    <div class={fldClass}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t">{label}</span>
          {req ? (
            <span class="gsv-fld-req">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span>
          ) : null}
        </div>
      ) : null}
      {description ? <div class="gsv-fld-desc">{description}</div> : null}
      <div class={rootClass}>
        <span class="gsv-st-btn" onClick={dec}>
          <svg width="11" height="11" viewBox="0 0 16 16" shape-rendering="crispEdges">
            <rect x="3" y="7" width="10" height="2" fill="currentColor" />
          </svg>
        </span>
        <span class="gsv-st-val">{display}</span>
        <span class="gsv-st-btn" onClick={inc}>
          <svg width="11" height="11" viewBox="0 0 16 16" shape-rendering="crispEdges">
            <g fill="currentColor">
              <rect x="7" y="3" width="2" height="10" />
              <rect x="3" y="7" width="10" height="2" />
            </g>
          </svg>
        </span>
      </div>
      {hasStat ? (
        <div class="gsv-fld-stat">
          <span class="gsv-fld-dot" />
          <span class="gsv-fld-msg">{message}</span>
        </div>
      ) : null}
    </div>
  );
}
