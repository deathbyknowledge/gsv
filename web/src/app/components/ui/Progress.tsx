import "./Progress.css";

export type ProgressSize = "small" | "medium" | "large";

export interface ProgressProps {
  value?: number;
  indeterminate?: boolean;
  label?: string;
  showValue?: boolean;
  size?: ProgressSize;
  width?: number;
}

const SIZE_CLASS: Record<ProgressSize, string> = {
  small: "gsv-pr-sm",
  medium: "gsv-pr-md",
  large: "gsv-pr-lg",
};

/** Progress — ported from Progress.dc.html. Determinate fill or indeterminate
 *  sweep, with optional label row + percentage. */
export function Progress({
  value = 60,
  indeterminate = false,
  label = "CONTEXT",
  showValue = true,
  size = "medium",
  width = 260,
}: ProgressProps) {
  const val = Number(value);
  const pct = Math.max(0, Math.min(100, isNaN(val) ? 0 : val));
  const showVal = showValue && !indeterminate;
  const hasTop = (label?.length ?? 0) > 0 || showVal;
  const rootClass = `gsv-pr ${SIZE_CLASS[size]}`;

  return (
    <div class={rootClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {hasTop ? (
        <div class="gsv-pr-top">
          <span class="gsv-pr-label gsv-sublabel">{label}</span>
          {showVal ? <span class="gsv-pr-num gsv-sublabel">{`${pct}%`}</span> : null}
        </div>
      ) : null}
      <div class="gsv-pr-track">
        {!indeterminate ? <div class="gsv-pr-fill" style={{ width: `${pct}%` }} /> : null}
        {indeterminate ? <div class="gsv-pr-indet" /> : null}
      </div>
    </div>
  );
}
