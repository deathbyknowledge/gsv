import { Button } from "./Button";
import "./ConfirmModal.css";

export interface ConfirmModalProps {
  title?: string;
  message?: string;
  note?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  /** Modal width in px (320–560). */
  width?: number;
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
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  return (
    <div
      style={{
        position: "relative",
        width: `${width}px`,
        maxWidth: "100%",
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
        <span style={{ fontSize: "11px", letterSpacing: ".2em", color: "#e8d7b0" }}>{title}</span>
        <button type="button" class="gsv-cm-close" aria-label="Close modal" onClick={onCancel}>
          {"✕"}
        </button>
      </div>

      <div style={{ display: "flex", gap: "16px", padding: "24px 22px 20px" }}>
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warn)"
          stroke-width="1.4"
          style={{ flex: "none", filter: "drop-shadow(0 0 6px rgba(224,166,76,.4))" }}
        >
          <path d="M12 3 L22 20 L2 20 Z" />
          <rect x="11.1" y="9" width="1.8" height="5.4" fill="var(--warn)" stroke="none" />
          <rect x="11.1" y="16" width="1.8" height="1.8" fill="var(--warn)" stroke="none" />
        </svg>
        <div style={{ paddingTop: "2px", fontFamily: "'Space Grotesk',sans-serif" }}>
          <div style={{ fontSize: "13.5px", lineHeight: "1.65", color: "var(--text)" }}>{message}</div>
          <div style={{ fontSize: "11px", color: "#9a95cf", marginTop: "9px", letterSpacing: ".04em" }}>{note}</div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "12px", padding: "0 22px 22px" }}>
        <Button variant="secondary" label={cancelLabel} onClick={onCancel} />
        <Button variant="danger" label={confirmLabel} onClick={onConfirm} />
      </div>
    </div>
  );
}
