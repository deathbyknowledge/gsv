import { LoadingState } from "../../../components/ui/Spinner";
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
  onClose,
  onAsk,
  enabled = true,
}: {
  file: OpenFile;
  onExpand?: () => void;
  placeLabel: string;
  onClose: () => void;
  onAsk: (text: string) => void;
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
  return (
    <div>
      <h3>{file.name}</h3>
      <div class="sub">
        {label} · {file.path}
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
        {linkedEntries ? (
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
        <button type="button" class="fleet-text-action" onClick={() => void navigator.clipboard?.writeText(file.path)}>
          {t("shell.file.copyPath")}
        </button>
        <button type="button" class="fleet-text-action" onClick={onClose}>
          {t("shell.close")}
        </button>
      </div>
      <p class="note">{t("shell.file.askNote", { place: label })}</p>
    </div>
  );
}
