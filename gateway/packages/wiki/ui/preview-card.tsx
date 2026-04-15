import { renderPreviewBodyHtml } from "./markdown";
import type { WikiPreviewPayload } from "./types";

type Props = {
  anchorRect: DOMRect;
  loading: boolean;
  payload: WikiPreviewPayload | null;
  error: string;
  onMouseEnter(): void;
  onMouseLeave(): void;
};

function positionFromRect(rect: DOMRect) {
  const width = Math.min(420, window.innerWidth - 24);
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right + 12));
  const top = Math.min(window.innerHeight - 24, Math.max(12, rect.top));
  return { left, top };
}

export function PreviewCard(props: Props) {
  const position = positionFromRect(props.anchorRect);
  let title = "Preview";
  const meta: string[] = [];
  if (props.payload && props.payload.ok) {
    title = props.payload.title || props.payload.path || title;
    if (props.payload.kind === "source") {
      if (props.payload.target) {
        meta.push(props.payload.target);
      }
      if (props.payload.path) {
        meta.push(props.payload.path);
      }
    } else if (props.payload.path) {
      meta.push(props.payload.path);
    }
  }
  const html = props.loading
    ? '<div class="preview-empty">Loading preview…</div>'
    : props.error
      ? `<div class="preview-empty">${props.error}</div>`
      : renderPreviewBodyHtml(props.payload || { ok: false, error: "Preview unavailable." });

  return (
    <div
      class="wiki-preview-card"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <h4>{title}</h4>
      {meta.length > 0 ? <div class="preview-meta">{meta.join(" · ")}</div> : null}
      <div class="preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
