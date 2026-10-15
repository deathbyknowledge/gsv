import type { ConversationAction } from "@humansandmachines/gsv/protocol";
import { LoadingState } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { readFilesPath } from "../../../services/files/backend/filesService";
import { CLOUD_TARGET_ID } from "../fleet/fleetModel";
import type { OpenFile } from "./PlaceFiles";

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
  onAsk: (action: ConversationAction) => void;
  enabled?: boolean;
}) {
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
        <dt>Size</dt>
        <dd>{payload && payload.ok && "size" in payload && payload.size !== null ? `${payload.size.toLocaleString()} bytes` : "—"}</dd>
        <dt>Lines</dt>
        <dd>{payload && payload.ok && "lines" in payload && payload.lines !== null ? payload.lines : "—"}</dd>
      </dl>
      <div class="file-preview">
        {read.isPending ? <p class="note"><LoadingState>{connected ? "reading…" : "Reconnecting…"}</LoadingState></p> : null}
        {error ? <p class="error">{error}</p> : null}
        {linkedEntries ? (
          <>
            {/* TODO: remove once fix/symlink-dirs is in a released daemon; machines then report linked folders as folders */}
            <p class="note">This is a folder reached through a link; the place reported it as a file. What it holds:</p>
            <pre>{linkedEntries.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).join("\n")}</pre>
          </>
        ) : null}
        {text !== null ? <pre>{text}</pre> : null}
        {image && image.type === "image" ? <img src={`data:${image.mimeType};base64,${image.data}`} alt={file.name} /> : null}
      </div>
      <div class="fleet-actions">
        {onExpand && <button type="button" class="fleet-text-action" onClick={onExpand}>expand</button>}
        <button type="button" class="fleet-text-action is-primary" onClick={() => onAsk({ kind: "file.discuss", target: file.target, path: file.path })}>
          talk about it
        </button>
        <button type="button" class="fleet-text-action" onClick={() => void navigator.clipboard?.writeText(file.path)}>
          copy path
        </button>
        <button type="button" class="fleet-text-action" onClick={onClose}>
          close
        </button>
      </div>
      <p class="note">Talking about it puts a reference to this file in the prompt; the ship reads it from {label} when it needs to, without copying it.</p>
    </div>
  );
}
