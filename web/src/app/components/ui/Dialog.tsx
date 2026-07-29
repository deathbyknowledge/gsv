import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import "./Dialog.css";

export interface DialogProps {
  /** Header title (machine-cased, e.g. "MODELS"). */
  title: string;
  /** When set, a back affordance renders left of the title — use it to exit a
   *  sub-view hosted inside the dialog without closing the whole dialog. */
  onBack?: () => void;
  /** Invoked by the ✕ button and the Escape key (and, when the dialog is
   *  wrapped in `.gsv-dialog-scrim`, a backdrop click). */
  onClose?: () => void;
  /** Optional trailing header content (a status chip, an action). */
  headerExtra?: ComponentChildren;
  /** Panel width in px (default 720); always caps at the viewport. */
  width?: number;
  /** Give the panel a tall, definite height so a hosted page can scroll its own
   *  body — otherwise the panel is sized to its content. */
  fill?: boolean;
  /** Drop the body padding so a hosted page owns its own layout. */
  flushBody?: boolean;
  className?: string;
  children: ComponentChildren;
}

/** Dialog — a general modal surface (header with title + optional back + close,
 *  bracket corners, scrollable body). Panel only, like ConfirmModal: wrap it in
 *  a `.gsv-dialog-scrim` layer to get the backdrop + centering (a bare backdrop
 *  <div onClick={onClose}> around it). Escape + a focus trap live in the panel. */
export function Dialog({
  title,
  onBack,
  onClose,
  headerExtra,
  width = 720,
  fill = false,
  flushBody = false,
  className = "",
  children,
}: DialogProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  // On mount, move focus into the dialog (the panel itself is focusable).
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Escape closes; Tab is trapped within the dialog.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // If a nested modal (e.g. a ConfirmModal) is open inside this dialog,
        // let it handle Escape — don't close the whole host dialog out from
        // under it. querySelector matches descendants only, never this root.
        const root = rootRef.current;
        if (root?.querySelector('[role="dialog"], [role="alertdialog"]')) {
          return;
        }
        onClose?.();
        return;
      }
      if (e.key === "Tab") {
        const root = rootRef.current;
        if (!root) return;
        // Only enabled, visible controls are real Tab stops — the browser skips
        // disabled/hidden ones, so including them as `first`/`last` would let the
        // wrap-around miss and focus escape behind the modal.
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      class={`gsv-dialog${fill ? " is-fill" : ""} ${className}`.trim()}
      style={{ width: `${width}px` }}
    >
      <span class="gsv-dialog-corner is-tl" aria-hidden="true" />
      <span class="gsv-dialog-corner is-tr" aria-hidden="true" />
      <span class="gsv-dialog-corner is-bl" aria-hidden="true" />
      <span class="gsv-dialog-corner is-br" aria-hidden="true" />

      <div class="gsv-dialog-head">
        {onBack ? (
          <button type="button" class="gsv-dialog-back" aria-label="Back" onClick={onBack}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M8 2.5 L4 6 L8 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
            </svg>
          </button>
        ) : null}
        <span class="gsv-dialog-dot" aria-hidden="true" />
        <span id={titleId} class="gsv-dialog-title gsv-label">{title}</span>
        {headerExtra ? <span class="gsv-dialog-head-extra">{headerExtra}</span> : null}
        <button type="button" class="gsv-dialog-close" aria-label="Close dialog" onClick={onClose}>
          {"✕"}
        </button>
      </div>

      <div class={`gsv-dialog-body${flushBody ? " is-flush" : ""}`}>{children}</div>
    </div>
  );
}
