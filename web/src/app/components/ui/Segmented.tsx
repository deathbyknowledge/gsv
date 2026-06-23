import { useState } from "preact/hooks";
import "./Segmented.css";

export type SegmentedSize = "small" | "medium" | "large";
export type SegmentedStatus = "none" | "error" | "success" | "info" | "warning";
export type SegmentedRequirement = "none" | "required" | "optional";

export interface SegmentedProps {
  l0?: string;
  l1?: string;
  l2?: string;
  l3?: string;
  value?: number;
  size?: SegmentedSize;
  disabled?: boolean;
  width?: number;
  label?: string;
  description?: string;
  requirement?: SegmentedRequirement;
  status?: SegmentedStatus;
  message?: string;
  onChange?: (index: number) => void;
}

const SIZE_CLASS: Record<SegmentedSize, string> = {
  small: "gsv-sg-sm",
  medium: "gsv-sg-md",
  large: "gsv-sg-lg",
};

/** Segmented — ported from Segmented.dc.html. Up to four segments (l0–l3),
 *  single selection, field label/desc/status. */
export function Segmented(props: SegmentedProps) {
  const {
    l0 = "ALLOW",
    l1 = "ASK",
    l2 = "DENY",
    l3 = "",
    size = "medium",
    disabled = false,
    width = 300,
    label = "",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    onChange,
  } = props;

  const [selState, setSelState] = useState<number | undefined>(undefined);
  const sel = selState === undefined ? props.value ?? 1 : selState;

  const req = requirement && requirement !== "none" ? requirement : "";
  const rawStatus = status && status !== "none" ? status : "";
  const statusKey = rawStatus === "warning" ? "warn" : rawStatus;
  const hasStatus = !!rawStatus && message.length > 0;
  const hasFldLabel = label.length > 0 || !!req;

  const has2 = l2 !== "";
  const has3 = !!l3;

  const sizeClass = SIZE_CLASS[size];
  const rootClass = `gsv-sg ${sizeClass}${disabled ? " is-disabled" : ""}`.trim();
  const fldClass = `gsv-fld${hasStatus ? ` is-${statusKey}` : ""}`;

  const pick = (i: number) => () => {
    setSelState(i);
    onChange?.(i);
  };

  const segCls = (i: number) => `gsv-sg-seg${sel === i ? " is-sel" : ""}`;

  return (
    <div class={fldClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t">{label}</span>
          {req ? <span class="gsv-fld-req">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
        </div>
      ) : null}
      {description.length > 0 ? <div class="gsv-fld-desc">{description}</div> : null}
      <div class={rootClass} style={{ width: "100%" }}>
        <button type="button" class={segCls(0)} disabled={disabled} onClick={pick(0)}>
          {l0}
        </button>
        <button type="button" class={segCls(1)} disabled={disabled} onClick={pick(1)}>
          {l1}
        </button>
        {has2 ? (
          <button type="button" class={segCls(2)} disabled={disabled} onClick={pick(2)}>
            {l2}
          </button>
        ) : null}
        {has3 ? (
          <button type="button" class={segCls(3)} disabled={disabled} onClick={pick(3)}>
            {l3}
          </button>
        ) : null}
      </div>
      {hasStatus ? (
        <div class="gsv-fld-stat">
          <span class="gsv-fld-dot" />
          <span class="gsv-fld-msg">{message}</span>
        </div>
      ) : null}
    </div>
  );
}
