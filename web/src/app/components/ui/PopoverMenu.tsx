import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { Icon } from "./Icon";
import { useRovingFocus } from "./useRovingFocus";
import "./PopoverMenu.css";

/** Header variants for the popover's top bar. */
export type PopoverHeader =
  /** Titled bar: uppercase title on the left, optional count on the right. */
  | { kind: "titled"; title: string; count?: ComponentChildren }
  /** Echo bar: reflects the current value with a trailing caret (e.g. model). */
  | { kind: "echo"; label: string };

export interface PopoverActionProps {
  label: string;
  onClick: () => void;
  /** Named Icon glyph rendered in the leading slot. */
  icon?: string;
  /** Custom leading node (e.g. a line glyph); takes precedence over `icon`. */
  glyph?: ComponentChildren;
  disabled?: boolean;
  ariaExpanded?: boolean;
}

/** PopoverAction — the standard footer action row for the popover family: a
 *  full-width button with a leading icon/glyph slot and a link-styled label
 *  (12px mono, uppercase, underlined). Shared visual language with the
 *  TwoLevelSelect footer link. */
export function PopoverAction({
  label,
  onClick,
  icon,
  glyph,
  disabled,
  ariaExpanded,
}: PopoverActionProps) {
  return (
    <button
      type="button"
      class="gsv-popover-action"
      disabled={disabled}
      aria-expanded={ariaExpanded}
      onClick={onClick}
    >
      {glyph ? (
        <span class="gsv-popover-action-glyph" aria-hidden="true">{glyph}</span>
      ) : icon ? (
        <span class="gsv-popover-action-glyph" aria-hidden="true">
          <Icon name={icon} size={12} />
        </span>
      ) : null}
      <span class="gsv-popover-action-label">{label}</span>
    </button>
  );
}

export interface PopoverMenuProps {
  header: PopoverHeader;
  children?: ComponentChildren;
  actions?: PopoverActionProps[];
  ariaLabel: string;
  /** Shell width preset — "menu" (256) for lists, "narrow" (232) for context. */
  width?: "menu" | "narrow";
  className?: string;
}

/** PopoverMenu — the shared shell for the chat header's popover family. Owns the
 *  chrome (panel background, border, shadow, entry animation), a header bar with
 *  two content variants (titled / echo), a body slot, and an optional footer of
 *  PopoverActions. Keeps `gsv-chat-popover` as an extra class so the host
 *  positioner keeps finding it. Roving arrow-key focus spans every enabled
 *  button inside. */
export function PopoverMenu({
  header,
  children,
  actions,
  ariaLabel,
  width = "menu",
  className = "",
}: PopoverMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useRovingFocus(rootRef);

  return (
    <div
      ref={rootRef}
      class={`gsv-popover gsv-popover--${width} gsv-chat-popover${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      <div class="gsv-popover-head">
        {header.kind === "titled" ? (
          <>
            <span class="gsv-popover-head-title">{header.title}</span>
            {header.count !== undefined && header.count !== null ? (
              <span class="gsv-popover-head-count">{header.count}</span>
            ) : null}
          </>
        ) : (
          <>
            <span class="gsv-popover-head-echo">{header.label}</span>
            <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
              <path d="M0 0 L9 0 L4.5 6 Z" fill="currentColor" />
            </svg>
          </>
        )}
      </div>
      {children}
      {actions && actions.length > 0 ? (
        <div class="gsv-popover-actions">
          {actions.map((action) => (
            <PopoverAction key={action.label} {...action} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
