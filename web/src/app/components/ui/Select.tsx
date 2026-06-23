import { useEffect, useRef, useState } from "preact/hooks";
import "./Select.css";

export type SelectSize = "small" | "medium" | "large";
export type SelectStatus = "none" | "error" | "success" | "info" | "warning";
export type SelectRequirement = "none" | "required" | "optional";

export interface SelectProps {
  o0?: string;
  o1?: string;
  o2?: string;
  options?: string[];
  value?: number;
  size?: SelectSize;
  disabled?: boolean;
  width?: number;
  label?: string;
  description?: string;
  requirement?: SelectRequirement;
  status?: SelectStatus;
  message?: string;
  onChange?: (index: number) => void;
}

const SIZE_CLASS: Record<SelectSize, string> = {
  small: "gsv-sel-sm",
  medium: "gsv-sel-md",
  large: "gsv-sel-lg",
};

/** Select — ported from Select.dc.html. Custom dropdown with an options array
 *  (falls back to o0/o1/o2), outside-click close, field label/desc/status. */
export function Select(props: SelectProps) {
  const {
    o0 = "GATEWAY DEFAULT",
    o1 = "FAST MODEL",
    o2 = "DEEP MODEL",
    options,
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

  const [open, setOpen] = useState(false);
  const [idxState, setIdxState] = useState<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const arr = Array.isArray(options) ? options.filter((x) => x != null) : null;
  const opts = arr && arr.length ? arr : [o0, o1, o2];

  const rawIdx = idxState === undefined ? props.value ?? 0 : idxState;
  const idx = Math.max(0, Math.min(Number(rawIdx) || 0, opts.length - 1));
  const isOpen = open && !disabled;

  const req = requirement && requirement !== "none" ? requirement : "";
  const rawStatus = status && status !== "none" ? status : "";
  const statusKey = rawStatus === "warning" ? "warn" : rawStatus;
  const hasStatus = !!rawStatus && message.length > 0;
  const hasFldLabel = label.length > 0 || !!req;

  const sizeClass = SIZE_CLASS[size];
  const rootClass = `gsv-sel ${sizeClass}${isOpen ? " is-open" : ""}${disabled ? " is-disabled" : ""}`.trim();
  const fldClass = `gsv-fld${hasStatus ? ` is-${statusKey}` : ""}`;

  const toggle = () => {
    if (disabled) return;
    setOpen((o) => !o);
  };

  const pick = (i: number) => {
    setIdxState(i);
    setOpen(false);
    onChange?.(i);
  };

  return (
    <div class={fldClass} style={{ width: `${width}px`, maxWidth: "100%" }}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t">{label}</span>
          {req ? <span class="gsv-fld-req">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
        </div>
      ) : null}
      {description.length > 0 ? <div class="gsv-fld-desc">{description}</div> : null}
      <div ref={rootRef} class={rootClass} style={{ width: "100%" }}>
        <button type="button" class="gsv-sel-trig" disabled={disabled} onClick={toggle}>
          <span class="gsv-sel-val">{opts[idx]}</span>
          <span style={{ marginLeft: "auto", display: "flex" }}>
            <svg width="9" height="6" viewBox="0 0 9 6">
              <path d="M0 0 L9 0 L4.5 6 Z" fill="#b3aeff" />
            </svg>
          </span>
        </button>
        {isOpen ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "100%",
              marginTop: "4px",
              zIndex: 20,
              background: "#13112e",
              border: "1px solid #4a449e",
              boxShadow: "0 12px 30px rgba(0,0,0,.55)",
            }}
          >
            {opts.map((optLabel, i) => (
              <button
                type="button"
                class="gsv-sel-row"
                key={i}
                style={i === idx ? { background: "#171441" } : undefined}
                onClick={() => pick(i)}
              >
                <span style={{ fontSize: "11px", letterSpacing: ".03em", color: i === idx ? "#fff" : "#c4bfee" }}>
                  {optLabel}
                </span>
                {i === idx ? (
                  <span
                    style={{
                      marginLeft: "auto",
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: "#cbc7ff",
                      boxShadow: "0 0 6px #cbc7ff",
                    }}
                  />
                ) : null}
              </button>
            ))}
          </div>
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
