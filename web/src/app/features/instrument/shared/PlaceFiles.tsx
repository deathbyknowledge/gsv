import { useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { readFilesPath } from "../../../services/files/backend/filesService";
import { LoadingState } from "../../../components/ui/Spinner";
import type { FleetRow } from "../Instrument";
import { CLOUD_TARGET_ID, type Place } from "../fleet/fleetModel";

export type OpenFile = { target: string; path: string; name: string };
type OpenFileHandler = (file: OpenFile) => void;

function readArgsFor(target: string, path: string) {
  return { target: target === CLOUD_TARGET_ID ? null : target, path };
}

/** One directory level, read when opened; directories open in place, files open in the inspector. */
function DirNode({
  place,
  path,
  name,
  depth,
  enabled,
  onOpenFile,
  initiallyOpen = false,
}: {
  place: Place;
  path: string;
  name: string;
  depth: number;
  enabled: boolean;
  onOpenFile: OpenFileHandler;
  initiallyOpen?: boolean;
}) {
  const rowKey: FleetRow = `dir:${place.id}:${path}`;
  const { client } = useGateway();
  const [open, setOpen] = useState(initiallyOpen);
  const listing = useQuery({
    queryKey: ["fleet", "files", place.id, path],
    queryFn: () => readFilesPath(client, readArgsFor(place.id, path)),
    enabled: enabled && open,
  });
  const entries = listing.data && listing.data.ok && "entries" in listing.data ? listing.data.entries : [];
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
        {depth === 0 ? <span class="m">{enabled ? "~" : "offline"}</span> : null}
      </div>
      {open ? (
        <ul>
          {listing.isPending ? <li class="m">{enabled ? <LoadingState>reading…</LoadingState> : "offline"}</li> : null}
          {error ? <li class="m">{error}</li> : null}
          {entries.slice(0, 60).map((entry) =>
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
          {entries.length > 60 ? <li class="m">… {entries.length - 60} more</li> : null}
          {!listing.isPending && !error && entries.length === 0 ? <li class="m">empty</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function PlaceTree({ place, enabled, onOpenFile, initiallyOpen }: { place: Place; enabled: boolean; onOpenFile: OpenFileHandler; initiallyOpen?: boolean }) {
  // the cloud home understands "~"; a machine reads relative to the daemon's home, so "." is the same place there
  return <DirNode place={place} path={place.id === CLOUD_TARGET_ID ? "~" : "."} name={place.label} depth={0} enabled={enabled} onOpenFile={onOpenFile} initiallyOpen={initiallyOpen} />;
}
