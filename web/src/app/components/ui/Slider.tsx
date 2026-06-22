import { useRef, useState, useEffect } from "preact/hooks";
import "./Slider.css";

export type SliderRequirement = "none" | "required" | "optional";
export type SliderStatus = "none" | "error" | "success" | "info" | "warning";

export interface SliderProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  description?: string;
  requirement?: SliderRequirement;
  status?: SliderStatus;
  message?: string;
  showValue?: boolean;
  disabled?: boolean;
  width?: number;
  onChange?: (value: number) => void;
}

/** Slider — ported from Slider.dc.html. Draggable value track with optional
 *  label / value readout / description / status row. */
export function Slider(props: SliderProps) {
  const {
    min = 0,
    max = 100,
    step = 1,
    label = "TEMPERATURE",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    showValue = true,
    disabled = false,
    width = 260,
    onChange,
  } = props;

  const [val, setVal] = useState<number | undefined>(undefined);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const value = val === undefined ? props.value ?? 40 : val;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const pctStr = pct + "%";

  const req = requirement && requirement !== "none" ? requirement : "";
  const rawStat = status && status !== "none" ? status : "";
  const statKey = rawStat === "warning" ? "warn" : rawStat;
  const hasStat = !!rawStat && message.length > 0;

  const rootClass =
    "gsv-sl" + (disabled ? " is-disabled" : "") + (hasStat ? " is-" + statKey : "");
  const hasTop = label.length > 0 || showValue || !!req;

  const setFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let p = r.width ? (clientX - r.left) / r.width : 0;
    p = Math.max(0, Math.min(1, p));
    let v = min + p * (max - min);
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    setVal(v);
    onChange?.(v);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      setFromX(e.clientX);
    };
    const up = () => {
      draggingRef.current = false;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
  });

  const onDown = disabled
    ? undefined
    : (e: PointerEvent) => {
        draggingRef.current = true;
        setFromX(e.clientX);
      };

  return (
    <div class={rootClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {hasTop ? (
        <div class="gsv-sl-top">
          <span class="gsv-sl-label">
            {label}
            {req ? (
              <span class="gsv-sl-req">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span>
            ) : null}
          </span>
          {showValue ? <span class="gsv-sl-num">{value}</span> : null}
        </div>
      ) : null}
      {description ? <div class="gsv-sl-desc">{description}</div> : null}
      <div class="gsv-sl-hit" onPointerDown={onDown}>
        <div class="gsv-sl-track" ref={trackRef}>
          <div class="gsv-sl-fill" style={{ width: pctStr }} />
          <div class="gsv-sl-thumb" style={{ left: pctStr }} />
        </div>
      </div>
      {hasStat ? (
        <div class="gsv-sl-stat">
          <span class="gsv-sl-dot" />
          <span class="gsv-sl-msg">{message}</span>
        </div>
      ) : null}
    </div>
  );
}
