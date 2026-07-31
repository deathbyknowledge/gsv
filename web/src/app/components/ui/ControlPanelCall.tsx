import { Icon } from "./Icon";
import "./ControlPanelCall.css";

export interface ControlPanelCallProps {
  /** Opens the terminal. */
  onOpen?: () => void;
  className?: string;
}

/** ControlPanelCall — a compact call-to-action that opens the terminal. Sized
 *  like the collapsed chat, with the terminal glyph carrying the same accent
 *  "glow" treatment used on the shell tabs. */
export function ControlPanelCall({ onOpen, className = "" }: ControlPanelCallProps) {
  return (
    <button
      type="button"
      class={`gsv-cpc ${className}`.trim()}
      onClick={onOpen}
      disabled={!onOpen}
      aria-label="Open terminal"
    >
      <span class="gsv-cpc-glyph" aria-hidden="true">
        <Icon name="terminal" size={20} />
      </span>
      <span class="gsv-cpc-text">
        <span class="gsv-cpc-title gsv-listitem">CONTROL PANEL</span>
        <span class="gsv-cpc-sub gsv-sublabel">OPEN TERMINAL</span>
      </span>
      <span class="gsv-cpc-chevron" aria-hidden="true">
        <svg width="9" height="12" viewBox="0 0 9 12">
          <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
        </svg>
      </span>
    </button>
  );
}
