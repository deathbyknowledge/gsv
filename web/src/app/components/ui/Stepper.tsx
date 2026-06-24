import { Fragment } from "preact";
import { useState } from "preact/hooks";
import "./Stepper.css";

export type StepperSize = "small" | "medium" | "large";

export interface StepperProps {
  count?: number;
  current?: number;
  l0?: string;
  l1?: string;
  l2?: string;
  l3?: string;
  l4?: string;
  size?: StepperSize;
  width?: number;
  onChange?: (current: number) => void;
}

const SIZE_CLASS: Record<StepperSize, string> = {
  small: "gsv-sp-sm",
  medium: "gsv-sp-md",
  large: "gsv-sp-lg",
};

/** Stepper — ported from Stepper.dc.html. Step / wizard progress indicator with
 *  clickable numbered dots, connecting lines and optional per-step labels. */
export function Stepper(props: StepperProps) {
  const { count = 4, current = 1, l0, l1, l2, l3, l4, size = "medium", width = 360, onChange } = props;

  const [stateCur, setStateCur] = useState<number | undefined>(undefined);

  // When a parent wires onChange the Stepper is controlled — it always mirrors
  // the parent's `current`. Without onChange it self-navigates via local state
  // (e.g. the catalog demo).
  const controlled = onChange != null;

  const names = [l0, l1, l2, l3, l4].filter((x) => x != null && x !== "") as string[];
  const stepCount = names.length ? names.length : Math.max(2, Math.min(6, count));
  const cur = controlled || stateCur === undefined ? current : stateCur;

  const sizeClass = SIZE_CLASS[size];
  const rootClass = ("gsv-sp " + sizeClass).trim();

  const steps = [];
  for (let i = 0; i < stepCount; i++) {
    const st = i < cur ? "done" : i === cur ? "cur" : "next";
    // Only completed steps (before the current one) are navigable — clicking
    // them goes back. The current step and any later steps are not clickable.
    const navigable = i < cur;
    steps.push({
      num: i + 1,
      hasLine: i > 0,
      lineCls: "gsv-sp-line " + (i <= cur ? "is-done" : "is-next"),
      dotCls: "gsv-sp-dot is-" + st,
      hasLabel: !!(names.length && names[i]),
      label: names.length ? names[i] || "" : "",
      labelCls: "gsv-sp-label is-" + st,
      navigable,
      pick: navigable
        ? () => {
            if (!controlled) setStateCur(i);
            onChange?.(i);
          }
        : undefined,
    });
  }

  return (
    <div role="group" aria-label="Progress" class={rootClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {steps.map((s, i) => (
        <Fragment key={s.num}>
          {s.hasLine ? <span class={s.lineCls} /> : null}
          <button
            type="button"
            class="gsv-sp-step"
            disabled={!s.navigable}
            aria-current={i === cur ? "step" : undefined}
            aria-label={`Step ${s.num}${s.label ? `: ${s.label}` : ""}`}
            onClick={s.pick}
          >
            <span class={s.dotCls}>{s.num}</span>
            {s.hasLabel ? <span class={s.labelCls}>{s.label}</span> : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
