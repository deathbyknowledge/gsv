import { useEffect, useId, useRef, useState } from "preact/hooks";
import { InfoTip } from "./InfoTip";
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
  /** Accessible name for the radiogroup when the visible label is rendered
   *  externally (no `label` prop). Ignored when `label` is set. */
  ariaLabel?: string;
  info?: string;
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
    l2 = "BLOCK",
    l3 = "",
    size = "medium",
    disabled = false,
    width = 300,
    label = "",
    info = "",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    onChange,
  } = props;

  const [selState, setSelState] = useState<number | undefined>(undefined);
  // Stay controlled: when the parent supplies a new `value` (e.g. a RESET that
  // restores the saved selection), drop the local click state so the control
  // reflects the incoming value instead of the last-clicked segment. Uncontrolled
  // callers pass a static `value`, so this never fires for them after mount.
  useEffect(() => {
    setSelState(undefined);
  }, [props.value]);
  const sel = selState === undefined ? props.value ?? 1 : selState;
  const groupId = useId();
  const segRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Indices of the segments actually rendered (respecting has2/has3).
  const segIndices = [0, 1, ...(has2 ? [2] : []), ...(has3 ? [3] : [])];

  const pick = (i: number) => () => {
    setSelState(i);
    onChange?.(i);
  };

  const moveTo = (i: number) => {
    setSelState(i);
    onChange?.(i);
    segRefs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const pos = segIndices.indexOf(sel);
    const cur = pos < 0 ? 0 : pos;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = segIndices[(cur + 1) % segIndices.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = segIndices[(cur - 1 + segIndices.length) % segIndices.length];
        break;
      case "Home":
        next = segIndices[0];
        break;
      case "End":
        next = segIndices[segIndices.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== null) moveTo(next);
  };

  const segCls = (i: number) => `gsv-sg-seg${sel === i ? " is-sel" : ""}`;

  const labelId = hasFldLabel ? `${groupId}-label` : undefined;
  const descId = description.length > 0 ? `${groupId}-desc` : undefined;
  const msgId = hasStatus ? `${groupId}-msg` : undefined;
  const describedBy = [descId, msgId].filter(Boolean).join(" ") || undefined;

  const segProps = (i: number) => ({
    type: "button" as const,
    class: segCls(i),
    disabled,
    role: "radio" as const,
    "aria-checked": sel === i,
    tabIndex: sel === i ? 0 : -1,
    ref: (el: HTMLButtonElement | null) => {
      segRefs.current[i] = el;
    },
    onClick: pick(i),
    onKeyDown,
  });

  return (
    <div class={fldClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t gsv-sublabel" id={labelId}>{label}</span>
          {req ? <span class="gsv-fld-req gsv-sublabel">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          {info ? <InfoTip text={info} /> : null}
        </div>
      ) : null}
      {description.length > 0 ? <div class="gsv-fld-desc gsv-paragraph-small" id={descId}>{description}</div> : null}
      <div
        class={rootClass}
        style={{ width: "100%" }}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : props.ariaLabel || undefined}
        aria-describedby={describedBy}
        aria-invalid={status === "error" ? true : undefined}
      >
        <button {...segProps(0)}>{l0}</button>
        <button {...segProps(1)}>{l1}</button>
        {has2 ? <button {...segProps(2)}>{l2}</button> : null}
        {has3 ? <button {...segProps(3)}>{l3}</button> : null}
      </div>
      {hasStatus ? (
        <div class="gsv-fld-stat">
          <span class="gsv-fld-dot" />
          <span class="gsv-fld-msg gsv-sublabel" id={msgId}>{message}</span>
        </div>
      ) : null}
    </div>
  );
}
