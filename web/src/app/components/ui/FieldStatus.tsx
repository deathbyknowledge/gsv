import "./FieldStatus.css";

export type FieldStatusTone = "none" | "error" | "success" | "info" | "warning";

export interface FieldStatusProps {
  status?: FieldStatusTone;
  /** The note shown beside the status dot; empty keeps the row's height without a dot. */
  message?: string;
  /** Element id for a control's aria-describedby. */
  id?: string;
}

const TONE_CLASS = { none: "", error: "is-error", success: "is-success", info: "is-info", warning: "is-warn" };

/** FieldStatus — the note row under a field: a tone-coloured dot and a short
 *  message, as TextInput and Select draw beneath their controls. Standalone
 *  for fields that are not inputs (a copyable command). The row keeps its
 *  height while empty so a transient note such as "copied" does not move the
 *  content below it. */
export function FieldStatus({ status = "none", message = "", id }: FieldStatusProps) {
  const tone = message.length > 0 ? status : "none";
  return (
    <div class={`gsv-fld-stat${tone === "none" ? "" : ` ${TONE_CLASS[tone]}`}`} aria-live="polite">
      {message.length > 0 ? (
        <>
          <span class="gsv-fld-dot" aria-hidden="true" />
          <span class="gsv-fld-msg gsv-sublabel" id={id} role={tone === "error" ? "alert" : undefined}>{message}</span>
        </>
      ) : null}
    </div>
  );
}
