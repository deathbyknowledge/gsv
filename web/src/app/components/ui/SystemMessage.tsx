import "./SystemMessage.css";

export interface SystemMessageProps {
  text?: string;
  time?: string;
  onCopy?: () => void;
}

/** SystemMessage — ported from SystemMessage.dc.html. Avatar + message bubble
 *  with a meta row showing the timestamp and a copy action. */
export function SystemMessage({
  text = "Scaffold's live. What should we call them — and how should they behave?",
  time = "14:22",
  onCopy,
}: SystemMessageProps) {
  return (
    <div class="gsv-sm">
      <div class="gsv-sm-avatar">
        <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
          <g fill="#eef1f8">
            <rect x="7" y="1" width="2" height="2" />
            <rect x="6" y="3" width="4" height="6" />
            <rect x="4" y="6" width="2" height="3" />
            <rect x="10" y="6" width="2" height="3" />
            <rect x="7" y="11" width="2" height="3" fill="#a9a4ff" />
          </g>
        </svg>
      </div>
      <div class="gsv-sm-body">
        <div class="gsv-sm-text">{text}</div>
        <div class="gsv-sm-meta">
          <span>{time}</span>
          <span class="gsv-sm-copy" onClick={onCopy}>
            <svg width="10" height="10" viewBox="0 0 16 16">
              <g fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="6" y="6" width="7" height="7" />
              </g>
            </svg>
            COPY
          </span>
        </div>
      </div>
    </div>
  );
}
