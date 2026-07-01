import { useEffect, useId, useRef, useState } from "preact/hooks";
import { InfoTip } from "./InfoTip";
import "./Select.css";

export type SelectSize = "small" | "medium" | "large";
export type SelectStatus = "none" | "error" | "success" | "info" | "warning";
export type SelectRequirement = "none" | "required" | "optional";
export type SelectOption = string | {
  label: string;
  value?: string;
  description?: string;
  group?: string;
};

export interface SelectProps {
  o0?: string;
  o1?: string;
  o2?: string;
  options?: SelectOption[];
  value?: number;
  size?: SelectSize;
  disabled?: boolean;
  width?: number;
  /** Stretch to fill the container width (ignores `width`). */
  block?: boolean;
  label?: string;
  info?: string;
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
    block = false,
    label = "",
    info = "",
    description = "",
    requirement = "none",
    status = "none",
    message = "",
    onChange,
  } = props;

  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [internalIdx, setInternalIdx] = useState(props.value ?? 0);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const arr = Array.isArray(options) ? options.filter((x) => x != null) : null;
  const opts = (arr && arr.length ? arr : [o0, o1, o2]).map(normalizeSelectOption);

  const controlled = props.value !== undefined;
  const rawIdx = controlled ? props.value ?? 0 : internalIdx;
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

  const labelId = `${fieldId}-label`;
  const descId = `${fieldId}-desc`;
  const msgId = `${fieldId}-msg`;
  const triggerId = `${fieldId}-trigger`;
  const listId = `${fieldId}-list`;
  const optId = (i: number) => `${fieldId}-opt-${i}`;

  const triggerLabelledBy = (hasFldLabel && label.length > 0 ? `${labelId} ` : "") + triggerId;
  const describedByParts: string[] = [];
  if (description.length > 0) describedByParts.push(descId);
  if (hasStatus) describedByParts.push(msgId);
  const triggerDescribedBy = describedByParts.length ? describedByParts.join(" ") : undefined;

  // When opening, focus the listbox and highlight the current value.
  useEffect(() => {
    if (isOpen) {
      setHighlight(idx);
      listRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const row = document.getElementById(optId(highlight));
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [highlight, isOpen]);

  const openList = () => {
    if (disabled) return;
    setHighlight(idx);
    setOpen(true);
  };

  const closeList = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (disabled) return;
    setOpen((o) => !o);
  };

  const pick = (i: number) => {
    if (!controlled) {
      setInternalIdx(i);
    }
    setOpen(false);
    onChange?.(i);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    const last = opts.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlight((h) => (h >= last ? 0 : h + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlight((h) => (h <= 0 ? last : h - 1));
        break;
      case "Home":
        e.preventDefault();
        setHighlight(0);
        break;
      case "End":
        e.preventDefault();
        setHighlight(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(highlight);
        break;
      case "Escape":
        e.preventDefault();
        closeList(true);
        break;
      case "Tab":
        closeList(false);
        break;
    }
  };

  return (
    <div class={fldClass} style={block ? { width: "100%" } : { width: `${width}px`, maxWidth: "100%" }}>
      {hasFldLabel ? (
        <div class="gsv-fld-lab">
          <span class="gsv-fld-lab-t" id={label.length > 0 ? labelId : undefined}>{label}</span>
          {req ? <span class="gsv-fld-req">{req === "required" ? "· REQUIRED" : "· OPTIONAL"}</span> : null}
          {info ? <InfoTip text={info} /> : null}
        </div>
      ) : null}
      {description.length > 0 ? <div class="gsv-fld-desc" id={descId}>{description}</div> : null}
      <div ref={rootRef} class={rootClass} style={{ width: "100%" }}>
        <button
          type="button"
          class="gsv-sel-trig"
          id={triggerId}
          ref={triggerRef}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-labelledby={triggerLabelledBy}
          aria-describedby={triggerDescribedBy}
          onClick={toggle}
          onKeyDown={onTriggerKeyDown}
        >
          <span class="gsv-sel-val">
            <span>{opts[idx].label}</span>
            {opts[idx].description ? <small>{opts[idx].description}</small> : null}
          </span>
          <span style={{ marginLeft: "auto", display: "flex" }}>
            <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
              <path d="M0 0 L9 0 L4.5 6 Z" fill="#b3aeff" />
            </svg>
          </span>
        </button>
        {isOpen ? (
          <div
            class="gsv-sel-list"
            id={listId}
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={hasFldLabel && label.length > 0 ? labelId : undefined}
            aria-activedescendant={optId(highlight)}
            onKeyDown={onListKeyDown}
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
              outline: "none",
            }}
          >
            {opts.flatMap((option, i) => {
              const previousGroup = i > 0 ? opts[i - 1]?.group : "";
              const showGroup = option.group && option.group !== previousGroup;
              const row = (
                <button
                  type="button"
                  class={`gsv-sel-row${i === highlight ? " is-highlighted" : ""}`}
                  key={`option:${i}`}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === idx}
                  tabIndex={-1}
                  style={i === idx ? { background: "#171441" } : undefined}
                  onClick={() => pick(i)}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <span class="gsv-sel-row-copy" style={{ color: i === idx ? "#fff" : "#c4bfee" }}>
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {i === idx ? (
                    <span
                      aria-hidden="true"
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
              );
              return showGroup
                ? [
                    <div class="gsv-sel-group" role="presentation" key={`group:${option.group}:${i}`}>{option.group}</div>,
                    row,
                  ]
                : [row];
            })}
          </div>
        ) : null}
      </div>
      {hasStatus ? (
        <div class="gsv-fld-stat">
          <span class="gsv-fld-dot" aria-hidden="true" />
          <span class="gsv-fld-msg" id={msgId}>{message}</span>
        </div>
      ) : null}
    </div>
  );
}

function normalizeSelectOption(option: SelectOption): { label: string; value: string; description: string; group: string } {
  if (typeof option === "string") {
    return { label: option, value: option, description: "", group: "" };
  }
  const label = String(option.label ?? "").trim();
  const value = String(option.value ?? label).trim();
  return {
    label: label || value,
    value,
    description: String(option.description ?? "").trim(),
    group: String(option.group ?? "").trim(),
  };
}
