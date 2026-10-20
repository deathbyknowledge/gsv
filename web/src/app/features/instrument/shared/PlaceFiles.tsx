import { useEffect, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readFilesPath } from "../../../services/files/backend/filesService";
import { parentPath } from "../../../services/files/domain/paths";
import { LoadingState } from "../../../components/ui/Spinner";
import type { FleetRow } from "../Instrument";
import { CLOUD_TARGET_ID, type Place } from "../fleet/fleetModel";
import { useT } from "../../../i18n/locale";

export type OpenFile = { target: string; path: string; name: string };
type OpenFileHandler = (file: OpenFile) => void;

function readArgsFor(target: string, path: string) {
  return { target: target === CLOUD_TARGET_ID ? null : target, path };
}

/** One directory level, read when opened; directories open in place, files open in the inspector. */
// Chat's reference picker uses the same file callback to select a file immediately.
function DirNode({
  place,
  path,
  name,
  depth,
  enabled,
  onOpenFile,
  initiallyOpen = false,
  onParent,
}: {
  place: Place;
  path: string;
  name: string;
  depth: number;
  enabled: boolean;
  onOpenFile: OpenFileHandler;
  initiallyOpen?: boolean;
  onParent?: (path: string) => void;
}) {
  const t = useT();
  const rowKey: FleetRow = `dir:${place.id}:${path}`;
  const { client } = useGateway();
  const [open, setOpen] = useState(initiallyOpen);
  const [visible, setVisible] = useState(60);
  useEffect(() => setVisible(60), [path]);
  const listing = useQuery({
    queryKey: ["fleet", "files", place.id, path],
    queryFn: () => readFilesPath(client, readArgsFor(place.id, path)),
    enabled: enabled && open,
  });
  const entries = listing.data && listing.data.ok && "entries" in listing.data ? listing.data.entries : [];
  const directory = listing.data?.ok && "entries" in listing.data ? listing.data.path : null;
  const parent = directory ? parentPath(directory) : null;
  const error = listing.data && !listing.data.ok ? listing.data.error : listing.error ? String(listing.error) : null;
  const toggle = () => setOpen(!open);
  return (
    <div class={depth === 0 ? "" : "dir"}>
      <div
        class={`place-head${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-row={rowKey}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!event.repeat) toggle();
          }
        }}
      >
        <span class="tri">{open ? "▾" : "▸"}</span>
        {depth === 0 ? place.label : `${name}/`}
        {depth === 0 ? <span class="m" title={directory ?? path}>{enabled ? directory ?? path : t("shell.offline")}</span> : null}
      </div>
      {open ? (
        <ul>
          {onParent && parent && parent !== directory && <li><button type="button" class="file d" aria-label={t("shell.files.parent")} onClick={() => onParent(parent)}>../</button></li>}
          {listing.isPending ? <li class="m">{enabled ? <LoadingState>{t("shell.reading")}</LoadingState> : t("shell.offline")}</li> : null}
          {error ? <li class="m">{error}</li> : null}
          {entries.slice(0, visible).map((entry) =>
            entry.kind === "directory" ? (
              <li key={entry.path}>
                <DirNode place={place} path={entry.path} name={entry.name} depth={depth + 1} enabled={enabled} onOpenFile={onOpenFile} />
              </li>
            ) : (
              <li key={entry.path} class="f">
                <button
                  type="button"
                  class="file"
                  data-row={`file:${place.id}:${entry.path}`}
                  onClick={() => {
                    onOpenFile({ target: place.id, path: entry.path, name: entry.name });
                  }}
                >
                  {entry.name}
                </button>
              </li>
            ),
          )}
          {entries.length > visible ? <li><button type="button" class="file m" onClick={() => setVisible((count) => count + 60)}>{t("shell.files.showMore", { remaining: entries.length - visible })}</button></li> : null}
          {!listing.isPending && !error && entries.length === 0 ? <li class="m">{t("shell.files.empty")}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function PlaceTree({ place, enabled, onOpenFile, initiallyOpen }: { place: Place; enabled: boolean; onOpenFile: OpenFileHandler; initiallyOpen?: boolean }) {
  // the cloud home understands "~"; a machine reads relative to the daemon's home, so "." is the same place there
  const [path, setPath] = useState(place.id === CLOUD_TARGET_ID ? "~" : ".");
  return <DirNode place={place} path={path} name={place.label} depth={0} enabled={enabled} onOpenFile={onOpenFile} initiallyOpen={initiallyOpen} onParent={setPath} />;
}
