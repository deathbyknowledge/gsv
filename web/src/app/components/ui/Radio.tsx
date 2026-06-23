import { useId, useRef, useState } from "preact/hooks";
import "./Radio.css";

export type RadioSize = "small" | "medium" | "large";
export type RadioStatus = "none" | "error" | "success" | "info" | "warning";
export type RadioRequirement = "none" | "required" | "optional";

export interface RadioProps {
  o0?: string;
  o1?: string;
  o2?: string;
  o3?: string;
  value?: number;
  size?: RadioSize;
  disabled?: boolean;
  label?: string;
  description?: string;
  requirement?: RadioRequirement;
  status?: RadioStatus;
  message?: string;
  onChange?: (index: number) => void;
}

const SIZE_CLASS: Record<RadioSize, string> = {
  small: "gsv-rg-sm",
  medium: "gsv-rg-md",
  large: "gsv-rg-lg",
};

/** Radio — ported from Radio.dc.html. Self-selecting radio group built from up
 *  to four option labels, with optional field label/desc/requirement/status. */
export function Radio(props: RadioProps) {
  const {
    o0 = "ALLOW",
    o1 = "ASK",
    o2 = "DENY",
    o3 = "",
    size = "medium",
    disabled = false,
    label = "",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    onChange,
  } = props;

  const [idxState, setIdxState] = useState<number | undefined>(undefined);
  const nameRef = useRef(`gsv-radio-${Math.random().toString(36).slice(2)}`);
  const groupId = useId();

  const opts = [o0, o1, o2, o3].filter((x) => x != null && x !== "");
  const labels = opts.length ? opts : ["ALLOW", "ASK", "DENY"];
  const idx = idxState === undefined ? props.value ?? 0 : idxState;

  const req = requirement && requirement !== "none" ? requirement : "";
  const rawStat = status && status !== "none" ? status : "";
  const statKey = rawStat === "warning" ? "warn" : rawStat;
  const hasStat = !!rawStat && message.length > 0;

  const rootClass = `gsv-rg ${SIZE_CLASS[size]}${disabled ? " is-disabled" : ""}`;
  const fldClass = `gsv-fld${hasStat ? ` is-${statKey}` : ""}`;
  const hasFldLabel = label.length > 0 || !!req;
  const fldReq = req === "required" ? "· REQUIRED" : "· OPTIONAL";

  const pick = (i: number) => {
    setIdxState(i);
    onChange?.(i);
  };

  const labelId = hasFldLabel ? `${groupId}-label` : undefined;
  const descId = description ? `${groupId}-desc` : undefined;
  const msgId = hasStat ? `${groupId}-msg` : undefined;
  const describedBy = [descId, msgId].filter(Boolean).join(" ") || undefined;

  return (
    <div class={fldClass}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t" id={labelId}>{label}</span>
          {req ? <span class="gsv-fld-req">{fldReq}</span> : null}
        </div>
      ) : null}
      {description ? <div class="gsv-fld-desc" id={descId}>{description}</div> : null}
      <div
        class={rootClass}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={status === "error" ? true : undefined}
      >
        {labels.map((optLabel, i) => (
          <label class={`gsv-rd-opt${i === idx ? " is-on" : ""}`} key={i}>
            <input
              checked={i === idx}
              class="gsv-rd-input"
              disabled={disabled}
              name={nameRef.current}
              type="radio"
              onChange={() => pick(i)}
            />
            <span class="gsv-rd-ring">{i === idx ? <span class="gsv-rd-dot" /> : null}</span>
            <span class="gsv-rd-label">{optLabel}</span>
          </label>
        ))}
      </div>
      {hasStat ? (
        <div class="gsv-fld-stat">
          <span class="gsv-fld-dot" />
          <span class="gsv-fld-msg" id={msgId}>{message}</span>
        </div>
      ) : null}
    </div>
  );
}
