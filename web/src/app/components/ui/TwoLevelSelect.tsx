import { useRef } from "preact/hooks";
import "./TwoLevelSelect.css";

export interface TwoLevelSelectOption {
  id: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface TwoLevelSelectGroup {
  id: string;
  label: string;
  options: TwoLevelSelectOption[];
  /** Shown in place of the options when the group is empty. */
  emptyLabel?: string;
}

export interface TwoLevelSelectProps {
  /** Current value echoed in the dark header bar. */
  headerLabel: string;
  /** Labelled option groups — group label on the left, options on the right,
   *  a dotted divider between groups. */
  groups: TwoLevelSelectGroup[];
  onSelect: (groupId: string, optionId: string) => void;
  /** Trailing link-style action (e.g. "MANAGE MODELS"). */
  footer?: { label: string; onClick: () => void };
  ariaLabel?: string;
  className?: string;
}

/** TwoLevelSelect — headless grouped select: a header bar echoing the current
 *  value, labelled option groups with a checkmark on the selection, and an
 *  optional footer action. Carries no popover chrome of its own — the host
 *  owns trigger, positioning and background. */
export function TwoLevelSelect({
  headerLabel,
  groups,
  onSelect,
  footer,
  ariaLabel,
  className = "",
}: TwoLevelSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key !== "ArrowDown" && event.key !== "ArrowUp"
      && event.key !== "Home" && event.key !== "End"
    ) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const items = Array.from(root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      class={`gsv-tls${className ? ` ${className}` : ""}`}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      <div class="gsv-tls-head gsv-label">
        <span class="gsv-tls-head-label">{headerLabel}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
          <path d="M0 0 L9 0 L4.5 6 Z" fill="currentColor" />
        </svg>
      </div>
      {groups.map((group) => (
        <div class="gsv-tls-group" key={group.id}>
          <span class="gsv-tls-group-label gsv-sublabel">{group.label}</span>
          <div class="gsv-tls-group-options" role="group" aria-label={group.label}>
            {group.options.length > 0 ? group.options.map((option) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={option.selected ? "true" : "false"}
                class={`gsv-tls-opt${option.selected ? " is-selected" : ""}`}
                disabled={option.disabled}
                key={option.id}
                onClick={() => onSelect(group.id, option.id)}
              >
                <span class="gsv-tls-opt-label">{option.label}</span>
                {option.selected ? (
                  <svg class="gsv-tls-check" width="11" height="9" viewBox="0 0 11 9" aria-hidden="true">
                    <path d="M1 4.5 L4 7.5 L10 1" fill="none" stroke="currentColor" stroke-width="1.8" />
                  </svg>
                ) : null}
              </button>
            )) : (
              <div class="gsv-tls-empty gsv-sublabel">{group.emptyLabel ?? "EMPTY"}</div>
            )}
          </div>
        </div>
      ))}
      {footer ? (
        <button type="button" class="gsv-tls-footer" onClick={footer.onClick}>
          {footer.label}
        </button>
      ) : null}
    </div>
  );
}
