import { useEffect, useState } from "preact/hooks";
import { FieldStatus } from "../../../components/ui/FieldStatus";
import { IconButton } from "../../../components/ui/IconButton";
import { InfoTip } from "../../../components/ui/InfoTip";
import { LoadingState } from "../../../components/ui/Spinner";
import { Hint } from "../../../components/ui/Tooltip";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { readFilesPath } from "../../../services/files/backend/filesService";
import { CLOUD_TARGET_ID } from "../fleet/fleetModel";
import type { OpenFile } from "./PlaceFiles";
import { useT } from "../../../i18n/locale";

function readArgsFor(target: string, path: string) {
  return { target: target === CLOUD_TARGET_ID ? null : target, path };
}

const PREVIEW_LINES = 40;

/** A file in the inspector: a bounded preview, and the two things a person does with it here. */
export function FilePreview({
  file,
  onExpand,
  placeLabel: label,
  onAsk,
  onFolder,
  enabled = true,
}: {
  file: OpenFile;
  onExpand?: () => void;
  placeLabel: string;
  onAsk: (text: string) => void;
  /** Given when the path came from a link that could not say whether it names a folder; a folder then opens as one. */
  onFolder?: (path: string) => void;
  enabled?: boolean;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const read = useQuery({
    queryKey: ["fleet", "file", file.target, file.path],
    queryFn: () => readFilesPath(client, { ...readArgsFor(file.target, file.path), limit: PREVIEW_LINES }),
    enabled: enabled && connected,
  });
  const payload = read.data;
  const linkedEntries = payload && payload.ok && "entries" in payload ? payload.entries : null;
  const content = payload && payload.ok && "content" in payload ? payload.content : null;
  const text = content !== null && !Array.isArray(content) ? content : null;
  const image = Array.isArray(content) ? content.find((item) => item.type === "image") : null;
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
    navigator.clipboard.writeText(file.path).then(() => setCopied("copied"), () => setCopied("failed"));
  };
  return (
    <div>
      <h3>{file.name}</h3>
      <div class="file-preview-head">
        <div class="sub">
          <span>{label} · {file.path}</span>
          <Hint text={t("shell.file.copyPath")}>
            <IconButton glyph="copy" ghost size="small" ariaLabel={t("shell.file.copyPath")} onClick={copyPath} />
          </Hint>
        </div>
        <FieldStatus status={copied === "copied" ? "success" : copied === "failed" ? "error" : "none"}
          message={copied === "copied" ? t("shell.copied") : copied === "failed" ? t("shell.code.copyFailed") : ""} />
      </div>
      <dl class="fleet-kv">
        <dt>{t("shell.file.size")}</dt>
        <dd>{payload && payload.ok && "size" in payload && payload.size !== null
          ? t("shell.file.bytes", { count: payload.size, size: payload.size.toLocaleString() }) : "—"}</dd>
        <dt>{t("shell.file.lines")}</dt>
        <dd>{payload && payload.ok && "lines" in payload && payload.lines !== null ? payload.lines : "—"}</dd>
      </dl>
      <div class="file-preview">
        {read.isPending ? <p class="note"><LoadingState>{connected ? t("shell.reading") : t("shell.reconnecting")}</LoadingState></p> : null}
        {error ? <p class="error">{error}</p> : null}
        {linkedEntries && folder === null ? (
          <>
            {/* TODO: remove once fix/symlink-dirs is in a released daemon; machines then report linked folders as folders */}
            <p class="note">{t("shell.file.linkedFolder")}</p>
            <pre>{linkedEntries.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n")}</pre>
          </>
        ) : null}
        {text !== null ? <pre>{text}</pre> : null}
        {image && image.type === "image" ? <img src={`data:${image.mimeType};base64,${image.data}`} alt={file.name} /> : null}
      </div>
      <div class="fleet-actions">
        {onExpand && <button type="button" class="fleet-text-action" onClick={onExpand}>{t("shell.file.expand")}</button>}
        <button type="button" class="fleet-text-action is-primary" onClick={() => onAsk(`Use this file as context: @${file.target} ${file.path}`)}>
          {t("shell.file.ask")}
        </button>
        <InfoTip text={t("shell.file.askNote", { place: label })} />
      </div>
    </div>
  );
}
