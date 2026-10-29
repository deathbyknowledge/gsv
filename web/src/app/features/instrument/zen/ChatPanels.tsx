import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import { RetainedView } from "../../../services/navigation/ViewActivity";
import { FleetDialog } from "../fleet/FleetDialog";
import { ConnectPlace } from "../fleet/ConnectPlace";
import { orderPlaces, type FleetReference } from "../fleet/fleetModel";
import { PlaceTree, type OpenFile } from "../shared/PlaceFiles";
import { FilePreview } from "../shared/FilePreview";
import { fileName } from "../../../services/files/domain/paths";
import { canConfigure } from "../settings/settingsModel";
import type { PeopleOpenRequest } from "../people/People";
import { ChatActivity } from "./ChatActivity";
import { ChatPerson } from "./ChatPerson";
import { useT, type TextKey } from "../../../i18n/locale";
import type { ChatContext } from "./chatContextModel";
import "../fleet/fleet.css";
import "../people/people.css";

const TITLES = {
  activity: "chat.panel.plans",
  person: "chat.panel.person",
  files: "chat.panel.files",
  connect: "chat.panel.connect",
} satisfies Record<Exclude<ChatContext["kind"], "path">, TextKey>;

export function ChatPanels({ context, active, account, targets, ready, onClose, onConnected, onAsk, onFleet, onPeople, onDirty }: {
  context: ChatContext | null;
  active: boolean;
  account?: ConsoleAccount;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  onClose: () => void;
  onConnected: (target: string) => void;
  onAsk: (text: string) => void;
  onFleet: (reference: FleetReference) => void;
  onPeople: (request: PeopleOpenRequest) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT();
  const last = useRef<ChatContext>({ kind: "activity" });
  const activity = useRef<Extract<ChatContext, { kind: "activity" }>>({ kind: "activity" });
  const person = useRef<Extract<ChatContext, { kind: "person" }>>({ kind: "person" });
  const path = useRef<Extract<ChatContext, { kind: "path" }> | null>(null);
  if (context) last.current = context;
  if (context?.kind === "activity") activity.current = context;
  if (context?.kind === "person") person.current = context;
  if (context?.kind === "path") path.current = context;
  const [activityDirty, setActivityDirty] = useState(false);
  const [personDirty, setPersonDirty] = useState(false);
  useLayoutEffect(() => { onDirty(activityDirty || personDirty); }, [activityDirty, personDirty, onDirty]);
  const shown = last.current;
  const open = (kind: ChatContext["kind"]) => active && context?.kind === kind;
  const title = shown.kind === "path" ? shown.location.path : t(TITLES[shown.kind]);
  return <FleetDialog className={`chat-context-panel is-${shown.kind}`} open={active && context !== null} title={title} onClose={onClose}>
    <RetainedView active={open("activity")}><ChatActivity account={account} request={activity.current.request}
      onAsk={onAsk} onFleet={onFleet} onDirty={setActivityDirty} /></RetainedView>
    <RetainedView active={open("person")}><ChatPerson account={account} request={person.current}
      onAsk={onAsk} onPeople={onPeople} onDirty={setPersonDirty} /></RetainedView>
    <RetainedView active={open("files")}><ChatFiles targets={targets} ready={ready}
      allowed={!!account && canConfigure(account, "fs.read")} onAsk={onAsk} /></RetainedView>
    <RetainedView active={open("connect")}><ConnectPlace account={account} targets={targets} ready={ready}
      onClose={onClose} onConnected={onConnected} /></RetainedView>
    <RetainedView active={open("path")}>{path.current && <ChatPath key={`${path.current.location.kind}:${path.current.location.target}:${path.current.location.path}`}
      location={path.current.location} targets={targets} ready={ready} allowed={!!account && canConfigure(account, "fs.read")}
      onAsk={onAsk} onFleet={onFleet} />}</RetainedView>
  </FleetDialog>;
}

/** A path Ship wrote, opened over the chat: a file's preview, or a folder's tree with its files opening in place. */
export function ChatPath({ location, targets, ready, allowed, onAsk, onFleet }: {
  location: Extract<ChatContext, { kind: "path" }>["location"];
  targets: readonly ConsoleTarget[];
  ready: boolean;
  allowed: boolean;
  onAsk: (text: string) => void;
  onFleet: (reference: FleetReference) => void;
}) {
  const t = useT();
  const [file, setFile] = useState<OpenFile | null>(location.kind === "file"
    ? { target: location.target, path: location.path, name: fileName(location.path) } : null);
  const [folder, setFolder] = useState<string | null>(location.kind === "dir" ? location.path : null);
  if (!allowed) return <p class="note">{t("chat.panel.noFiles")}</p>;
  const place = orderPlaces([...targets]).find((candidate) => candidate.id === location.target) ?? null;
  if (file) return <>
    {folder !== null && <button type="button" class="fleet-text-action chat-context-back" onClick={() => setFile(null)}>← {fileName(folder)}</button>}
    <FilePreview file={file} placeLabel={place?.label ?? location.target} enabled={ready} onAsk={onAsk}
      expandLabel={t("shell.file.openInWork")} onExpand={() => onFleet(`file:${file.target}:${file.path}`)}
      // A link cannot say whether it names a folder; one that does opens as the folder's tree.
      onFolder={folder === null ? (path) => { setFolder(path); setFile(null); } : undefined} />
  </>;
  if (!place) return <p class="note">{t("chat.panel.noPlace")}</p>;
  return <div class="fleet-tree"><PlaceTree key={folder ?? ""} place={place} initialPath={folder ?? undefined}
    enabled={ready && place.online} onOpenFile={setFile} initiallyOpen /></div>;
}

function ChatFiles({ targets, ready, allowed, onAsk }: {
  targets: readonly ConsoleTarget[];
  ready: boolean;
  allowed: boolean;
  onAsk: (text: string) => void;
}) {
  const t = useT();
  if (!allowed) return <p class="note">{t("chat.panel.noFiles")}</p>;
  const places = orderPlaces([...targets]);
  return <div class="fleet-tree">{places.map((place) =>
    <PlaceTree key={place.id} place={place} enabled={ready && place.online}
      onOpenFile={(file) => onAsk(`Use this file as context: @${file.target} ${file.path}`)} />)}</div>;
}
