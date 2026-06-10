import { escapeHtml, renderPreviewBodyHtml } from "./markdown";
import type { WikiPreviewPayload } from "./types";
import { WikiIcon } from "./components/ui/wiki-icon";

type Props = {
  anchorRect: DOMRect;
  loading: boolean;
  payload: WikiPreviewPayload | null;
  error: string;
  pinned: boolean;
  onDismiss(): void;
  onMouseEnter(): void;
  onMouseLeave(): void;
  onOpenPage(path: string): void;
};

function positionFromRect(rect: DOMRect) {
  const margin = 12;
  const gap = 10;
  const width = Math.min(420, window.innerWidth - 24);
  const maxHeight = Math.min(520, Math.max(80, window.innerHeight - (margin * 2)));
  const leftCandidate = rect.right + gap + width <= window.innerWidth - margin
    ? rect.right + gap
    : rect.left - width - gap;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, leftCandidate));
  const topCandidate = window.innerHeight - rect.bottom - margin >= 180
    ? rect.bottom + gap
    : rect.top - maxHeight - gap;
  const maxTop = Math.max(margin, window.innerHeight - maxHeight - margin);
  const top = Math.min(maxTop, Math.max(margin, topCandidate));
  return { left, top, maxHeight };
}

export function PreviewCard(props: Props) {
  const position = positionFromRect(props.anchorRect);
  let title = "Preview";
  if (props.payload && props.payload.ok) {
    title = props.payload.title || props.payload.path || title;
  }
  const html = props.loading
    ? '<div class="preview-empty">Loading preview…</div>'
    : props.error
      ? `<div class="preview-empty">${escapeHtml(props.error)}</div>`
      : renderPreviewBodyHtml(props.payload || { ok: false, error: "Preview unavailable." });
  const canOpenPage = props.payload?.ok === true && props.payload.kind === "page" && Boolean(props.payload.path);

  return (
    <div
      class={`wiki-preview-card${props.pinned ? " is-pinned" : ""}`}
      data-preview-card="true"
      role="dialog"
      aria-label={`${title} preview`}
      style={{ left: `${position.left}px`, top: `${position.top}px`, maxHeight: `${position.maxHeight}px` }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <div class="preview-head">
        <h4>{title}</h4>
        <div class="preview-actions">
          {canOpenPage ? (
            <button
              type="button"
              class="preview-open"
              title="Open page"
              aria-label="Open previewed page"
              onClick={() => {
                if (props.payload?.ok === true && props.payload.kind === "page") {
                  props.onOpenPage(props.payload.path);
                }
              }}
            >
              <WikiIcon name="open" />
            </button>
          ) : null}
          <button type="button" class="preview-close" title="Close preview" aria-label="Close preview" onClick={props.onDismiss}>
            <WikiIcon name="close" />
          </button>
        </div>
      </div>
      <div class="preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
