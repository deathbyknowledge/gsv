import type { ComponentChildren } from "preact";
import "./FieldStatus.css";

export type FieldStatusTone = "none" | "error" | "success" | "info" | "warning";

export interface FieldStatusProps {
  status?: FieldStatusTone;
  /** The note shown beside the status dot; without one the row keeps its height and shows no dot. */
  message?: string;
  /** Element id for a control's aria-describedby. */
  id?: string;
  /** Announces each new note politely, for an outcome that follows an action (a copy). */
  live?: boolean;
  /** Trailing content at the row's end, such as a character counter. */
  children?: ComponentChildren;
}

const TONE_CLASS = { none: "", error: " is-error", success: " is-success", info: " is-info", warning: " is-warn" };

/** FieldStatus — the note row under a field: a tone-coloured dot and a short
 *  message. TextInput and Select draw it beneath their controls; it also
 *  stands alone under fields that are not inputs (a copyable command). */
export function FieldStatus({ status = "none", message = "", id, live = false, children }: FieldStatusProps) {
  const tone = message.length > 0 ? status : "none";
  return (
    <div class={`gsv-fld-stat${TONE_CLASS[tone]}`} aria-live={live ? "polite" : undefined}>
      {message.length > 0 ? (
        <>
          <span class="gsv-fld-dot" aria-hidden="true" />
          <span class="gsv-fld-msg gsv-sublabel" id={id} role={tone === "error" ? "alert" : undefined}>{message}</span>
        </>
      ) : null}
      {children}
    </div>
  );
}
