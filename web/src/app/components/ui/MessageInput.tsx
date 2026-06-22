import { useState } from "preact/hooks";
import "./MessageInput.css";

export interface MessageInputProps {
  placeholder?: string;
  user?: string;
  cost?: string;
  onSend?: () => void;
}

/** MessageInput — ported from MessageInput.dc.html. Chat input bar with
 *  attachment / text / voice / send controls, plus a meta row showing the
 *  current user and a toggleable session-cost tooltip. */
export function MessageInput({
  placeholder = "Message Xanadu…",
  user = "jessicat",
  cost = "0.04$",
  onSend,
}: MessageInputProps) {
  const [costTip, setCostTip] = useState(false);

  const toggleCost = (e: Event) => {
    e.stopPropagation();
    setCostTip((c) => !c);
  };
  const stop = (e: Event) => {
    e.stopPropagation();
  };

  return (
    <div class="gsv-mi">
      <div class="gsv-mi-bar">
        <span class="gsv-mi-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
            <g fill="currentColor">
              <rect x="10" y="2" width="2" height="2" />
              <rect x="8" y="4" width="2" height="2" />
              <rect x="6" y="6" width="2" height="2" />
              <rect x="5" y="8" width="2" height="3" />
              <rect x="6" y="11" width="3" height="2" />
              <rect x="9" y="9" width="2" height="2" />
              <rect x="11" y="4" width="2" height="5" />
            </g>
          </svg>
        </span>
        <input class="gsv-mi-input" placeholder={placeholder} />
        <span class="gsv-mi-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
            <g fill="currentColor">
              <rect x="6" y="2" width="4" height="7" />
              <rect x="4" y="7" width="1" height="2" />
              <rect x="11" y="7" width="1" height="2" />
              <rect x="5" y="9" width="6" height="1" />
              <rect x="7" y="10" width="2" height="3" />
              <rect x="5" y="13" width="6" height="1" />
            </g>
          </svg>
        </span>
        <span class="gsv-mi-send" onClick={onSend}>
          <svg width="17" height="17" viewBox="0 0 16 16">
            <path d="M2 3 L14 8 L2 13 L4 8 Z" fill="currentColor" />
          </svg>
        </span>
      </div>
      <div class="gsv-mi-meta">
        <span class="gsv-mi-user">{user}</span>
        <span class="gsv-mi-cost" onClick={toggleCost}>
          {cost}
          {costTip ? (
            <div class="gsv-mi-tip" onClick={stop}>
              <div class="gsv-mi-tip-title">CURRENT SESSION COST</div>
              <div class="gsv-mi-tip-link">learn more</div>
            </div>
          ) : null}
        </span>
      </div>
    </div>
  );
}
