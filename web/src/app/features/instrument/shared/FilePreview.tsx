import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { FieldStatus } from "../../../components/ui/FieldStatus";
import { IconButton } from "../../../components/ui/IconButton";
import { InfoTip } from "../../../components/ui/InfoTip";
import { LoadingState } from "../../../components/ui/Spinner";
import { Hint } from "../../../components/ui/Tooltip";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { readFilesPath } from "../../../services/files/backend/filesService";
import type { FilesErrorPayload, FilesFilePayload, FilesReadPayload } from "../../../services/files/domain/models";
import { formatChatMediaSize } from "../../../services/chat/domain/media";
import { useMediaPreview } from "../../../services/platform/MediaPreview";
import { CLOUD_TARGET_ID } from "../fleet/fleetModel";
import type { OpenFile } from "./PlaceFiles";
import { previewBody, type PreviewBody } from "./filePreviewModel";
import { escapeHtml, renderMarkdownHtml } from "./markdown";
import { enhanceCodeBlocks } from "./codeBlocks";
import { useT, type Translate } from "../../../i18n/locale";
import "./prose.css";
import "./filePreview.css";

function readArgsFor(target: string, path: string) {
  return { target: target === CLOUD_TARGET_ID ? null : target, path };
}

function isFile(payload: FilesReadPayload | FilesErrorPayload): payload is FilesFilePayload {
  return payload.ok && "content" in payload;
}

/** Enough of a file to know what it is; the full reader shows the rest. */
const PREVIEW_LINES = 400;
const PREVIEW_BYTES = 64 * 1024;

/** The way out of the preview into the full reader: Work's own expand, or chat's open in Work. */
export type PreviewOpen = { label: string; onOpen: () => void };

/** A file over the chat or in Work's inspector: the path, the contents with talk-about-it at their end, and the way to the full reader pinned beneath. */
export function FilePreview({
  file,
  placeLabel: label,
  onAsk,
  onFolder,
  open,
  enabled = true,
}: {
  file: OpenFile;
  placeLabel: string;
  onAsk: (text: string) => void;
  /** Given when the path came from a link that could not say whether it names a folder; a folder then opens as one. */
  onFolder?: (path: string) => void;
  open?: PreviewOpen;
  enabled?: boolean;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const read = useQuery({
    queryKey: ["fleet", "file", file.target, file.path],
    queryFn: () => readFilesPath(client, { ...readArgsFor(file.target, file.path), limit: PREVIEW_LINES, maxBytes: PREVIEW_BYTES }),
    enabled: enabled && connected,
  });
  const payload = read.data;
  const contents = payload && isFile(payload) ? payload : null;
  const body = contents ? previewBody(file.name, contents) : null;
  const error = payload && !payload.ok ? payload.error : read.error ? String(read.error) : null;
  const folder = onFolder && payload && payload.ok && "entries" in payload ? payload.path : null;
  useEffect(() => {
    if (folder !== null) onFolder?.(folder);
  }, [folder, onFolder]);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied === "idle") return;
    const settle = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(settle);
  }, [copied]);
  useEffect(() => { setCopied("idle"); }, [file.path]);
  const copyPath = () => {
    // Without the Clipboard API (an insecure context) the write throws before any promise exists; that is a failed copy too.
    Promise.resolve().then(() => navigator.clipboard.writeText(file.path)).then(() => setCopied("copied"), () => setCopied("failed"));
  };
  const size = contents ? formatChatMediaSize(contents.size) : "";
  const extent = contents?.truncated ? t("shell.file.firstLines", { count: contents.lines ?? 0 }) : "";
  return (
    <div class="file-preview">
      <div class="file-preview-head">
        <span class="file-preview-path">{label} · {file.path}</span>
        <Hint text={t("shell.file.copyPath")}>
          <IconButton glyph="copy" ghost size="small" ariaLabel={t("shell.file.copyPath")} onClick={copyPath} />
        </Hint>
        <FieldStatus status={copied === "copied" ? "success" : copied === "failed" ? "error" : "none"}
          message={copied === "copied" ? t("shell.copied") : copied === "failed" ? t("shell.code.copyFailed") : ""} />
      </div>
      <div class="file-preview-scroll" data-scroll-edge>
        <div class="file-preview-body">
          {read.isPending ? <p class="note"><LoadingState>{connected ? t("shell.reading") : t("shell.reconnecting")}</LoadingState></p> : null}
          {error ? <p class="note">{t("shell.file.noPreview")} <span class="file-preview-reason">{error}</span></p> : null}
          {body && body.kind !== "image" ? <FileText body={body} t={t} /> : null}
          {body?.kind === "image" ? <FileImage source={body.source} name={file.name} /> : null}
        </div>
        <div class="fleet-actions file-preview-ask">
          <button type="button" class="fleet-text-action is-primary" onClick={() => onAsk(`Use this file as context: @${file.target} ${file.path}`)}>
            {t("shell.file.ask")}
          </button>
          <InfoTip text={t("shell.file.askNote", { place: label })} />
        </div>
      </div>
      <footer class="file-preview-foot">
        <span class="file-preview-meta">{[size, extent].filter(Boolean).join(" · ")}</span>
        {open && <button type="button" class="fleet-text-action" onClick={open.onOpen}>{open.label}</button>}
      </footer>
    </div>
  );
}

/** Markdown rendered as a document, anything else as one code block; both through the sanitised renderer, so the element owns its markup. */
function FileText({ body, t }: { body: Extract<PreviewBody, { kind: "markdown" | "code" }>; t: Translate }) {
  const ref = useRef<HTMLDivElement>(null);
  const markdown = body.kind === "markdown";
  const language = body.kind === "code" ? body.language : "";
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.innerHTML = markdown
      ? renderMarkdownHtml(body.text)
      : `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(body.text)}</code></pre>`;
    enhanceCodeBlocks(element);
    // A file's links are its own: web links open in a tab, anything else stays put rather than moving the app.
    for (const anchor of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      if (/^(?:https?:|\/\/)/i.test(href)) {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      } else if (!/^mailto:/i.test(href)) {
        anchor.removeAttribute("href");
        anchor.setAttribute("aria-disabled", "true");
        anchor.title = t("shell.file.linkInactive");
      }
    }
  }, [markdown, body.text, language, t]);
  return <div class={markdown ? "prose" : "file-preview-code"} ref={ref} />;
}

/** The image itself; a host with its own viewer opens it there on a click. */
function FileImage({ source, name }: { source: string; name: string }) {
  const preview = useMediaPreview();
  const image = <img src={source} alt={name} />;
  if (!preview) return image;
  return <button type="button" class="file-preview-image" onClick={() => preview({ source, filename: name, description: name })}>{image}</button>;
}
