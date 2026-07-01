import type { ComponentChildren } from "preact";
import { IconButton } from "./IconButton";
import "./Alert.css";

export type AlertVariant = "info" | "attention" | "warning" | "neutral" | "success" | "error";

/** Built-in icon keys map to IconButton glyphs; "none" suppresses the icon. */
export type AlertIconKey = "info" | "attention" | "none";

export interface AlertProps {
  /** Colour treatment — follows the status reference palette. */
  variant?: AlertVariant;
  title?: string;
  text?: string;
  /** Leading icon: "info" (?) or "attention" (!) renders that IconButton glyph;
   *  "none" hides it; a custom node renders as-is. Omit to use a sensible
   *  default per variant. */
  icon?: AlertIconKey | ComponentChildren;
  /** Body content, rendered after the text (e.g. an action button). */
  children?: ComponentChildren;
}

const VARIANT_CLASS: Record<AlertVariant, string> = {
  info: "gsv-alert-info",
  attention: "gsv-alert-attention",
  warning: "gsv-alert-warning",
  neutral: "gsv-alert-neutral",
  success: "gsv-alert-success",
  error: "gsv-alert-error",
};

/** Sensible default icon per variant when `icon` is omitted. */
const DEFAULT_ICON: Record<AlertVariant, AlertIconKey> = {
  info: "info",
  attention: "attention",
  warning: "attention",
  neutral: "none",
  success: "none",
  error: "attention",
};

const ICON_GLYPH = { info: "help", attention: "attention" } as const;
const ICON_LABEL = { info: "Information", attention: "Attention" } as const;

export function Alert({ variant = "info", title, text, icon, children }: AlertProps) {
  const resolved = icon === undefined ? DEFAULT_ICON[variant] : icon;

  let iconNode: ComponentChildren = null;
  if (resolved === "info" || resolved === "attention") {
    iconNode = (
      <span class="gsv-alert-icon">
        <IconButton glyph={ICON_GLYPH[resolved]} ghost size={20} title={ICON_LABEL[resolved]} />
      </span>
    );
  } else if (resolved && resolved !== "none") {
    iconNode = <span class="gsv-alert-icon">{resolved}</span>;
  }

  return (
    <div class={`gsv-alert ${VARIANT_CLASS[variant]}`} role="note">
      {iconNode}
      <div class="gsv-alert-body">
        {title ? <div class="gsv-alert-title gsv-label">{title}</div> : null}
        {text ? <p class="gsv-alert-text gsv-prose">{text}</p> : null}
        {children}
      </div>
    </div>
  );
}
