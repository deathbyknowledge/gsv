import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { TextInput } from "./TextInput";
import "./ConfirmModal.css";

export interface ConfirmModalProps {
  title?: string;
  message?: string;
  note?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  /** Modal width in px (320–560). */
  width?: number;
  children?: ComponentChildren;
  /** When set, the confirm button stays disabled until the user types text that
   *  exactly matches this phrase (e.g. a file path before a destructive delete). */
  confirmPhrase?: string;
  /** Label for the confirm-phrase input. */
  confirmInputLabel?: string;
  /** Placeholder for the confirm-phrase input (often the phrase/path to type). */
  confirmInputPlaceholder?: string;
  onCancel?: () => void;
  onConfirm?: () => void;
}

/** ConfirmModal — ported from ConfirmModal.dc.html. A destructive-confirmation
 *  dialog surface composing two Buttons (secondary cancel + danger confirm). */
export function ConfirmModal({
  title = "CONFIRM DELETE",
  message = "Are you sure you want to delete “PERSONA”?",
  note = "This file is removed from the agent — it can’t be recovered.",
  cancelLabel = "CANCEL",
  confirmLabel = "DELETE",
  width = 440,
  children,
  confirmPhrase,
  confirmInputLabel = "TYPE TO CONFIRM",
  confirmInputPlaceholder,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  const titleId = useId();
  const descId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  // Confirm-phrase guard: when confirmPhrase is set, the danger button stays
  // disabled until the typed value matches it exactly. Undefined → no guard.
  const [typedValue, setTypedValue] = useState("");
  const phraseMatched = confirmPhrase === undefined || typedValue === confirmPhrase;

  // On mount, move focus to the Cancel (secondary) button.
  useEffect(() => {
    const cancelBtn = footerRef.current?.querySelector("button");
    cancelBtn?.focus();
  }, []);

  // Escape to cancel + a basic focus trap within the dialog.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel?.();
        return;
      }
      if (e.key === "Tab") {
        const root = rootRef.current;
        if (!root) return;
        const focusable = root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !root.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      style={{
        position: "relative",
        width: `${width}px`,
        maxWidth: "100%",
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0e0b24",
        border: "1px solid var(--primary-hi)",
        boxShadow: "0 0 0 1px #060414,0 18px 50px rgba(0,0,0,.6)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      <span style={{ position: "absolute", top: "5px", left: "5px", width: "9px", height: "9px", borderTop: "1px solid var(--bracket)", borderLeft: "1px solid var(--bracket)" }} />
      <span style={{ position: "absolute", top: "5px", right: "5px", width: "9px", height: "9px", borderTop: "1px solid var(--bracket)", borderRight: "1px solid var(--bracket)" }} />
      <span style={{ position: "absolute", bottom: "5px", left: "5px", width: "9px", height: "9px", borderBottom: "1px solid var(--bracket)", borderLeft: "1px solid var(--bracket)" }} />
      <span style={{ position: "absolute", bottom: "5px", right: "5px", width: "9px", height: "9px", borderBottom: "1px solid var(--bracket)", borderRight: "1px solid var(--bracket)" }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "9px",
          padding: "11px 14px",
          background: "var(--header-bar)",
          borderBottom: "1px solid var(--border-raised)",
        }}
      >
        <span style={{ width: "7px", height: "7px", flex: "none", borderRadius: "1px", background: "var(--warn)", boxShadow: "0 0 8px var(--warn)" }} />
        <span id={titleId} class="gsv-label" style={{ letterSpacing: ".2em", color: "#e8d7b0" }}>{title}</span>
        <button type="button" class="gsv-cm-close" aria-label="Close modal" onClick={onCancel}>
          {"✕"}
        </button>
      </div>

      <div style={{ display: "flex", gap: "16px", padding: "24px 22px 20px", flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warn)"
          stroke-width="1.4"
          aria-hidden="true"
          style={{ flex: "none", filter: "drop-shadow(0 0 6px rgba(224,166,76,.4))" }}
        >
          <path d="M12 3 L22 20 L2 20 Z" />
          <rect x="11.1" y="9" width="1.8" height="5.4" fill="var(--warn)" stroke="none" />
          <rect x="11.1" y="16" width="1.8" height="1.8" fill="var(--warn)" stroke="none" />
        </svg>
        <div style={{ paddingTop: "2px", fontFamily: "'Space Grotesk',sans-serif", minWidth: 0, overflowWrap: "anywhere" }}>
          <div id={descId} class="gsv-prose" style={{ lineHeight: "1.65", color: "var(--text)" }}>{message}</div>
          <div class="gsv-prose-sm" style={{ color: "#9a95cf", marginTop: "9px", letterSpacing: ".04em" }}>{note}</div>
          {children ? <div class="gsv-cm-extra">{children}</div> : null}
        </div>
      </div>

      {confirmPhrase !== undefined ? (
        <div style={{ padding: "0 22px 18px" }}>
          <TextInput
            value={typedValue}
            label={confirmInputLabel}
            placeholder={confirmInputPlaceholder ?? confirmPhrase}
            clearable
            status={phraseMatched && typedValue.length > 0 ? "success" : "none"}
            onChange={setTypedValue}
          />
        </div>
      ) : null}

      <div ref={footerRef} style={{ display: "flex", justifyContent: "flex-end", gap: "12px", padding: "0 22px 22px" }}>
        <Button variant="secondary" label={cancelLabel} onClick={onCancel} />
        <Button variant="danger" label={confirmLabel} disabled={!phraseMatched} onClick={onConfirm} />
      </div>
    </div>
  );
}
