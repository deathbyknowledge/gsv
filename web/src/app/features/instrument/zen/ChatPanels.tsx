import type { ConversationAction } from "@humansandmachines/gsv/protocol";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import { RetainedView, useViewActive } from "../../../services/navigation/ViewActivity";
import { FleetDialog } from "../fleet/FleetDialog";
import { ConnectPlace } from "../fleet/ConnectPlace";
import { orderPlaces, type FleetReference } from "../fleet/fleetModel";
import { PlaceTree } from "../shared/PlaceFiles";
import { FilePreview } from "../shared/FilePreview";
import { canConfigure } from "../settings/settingsModel";
import type { PeopleOpenRequest } from "../people/People";
import { ChatActivity } from "./ChatActivity";
import { ChatPerson } from "./ChatPerson";
import type { ChatContext } from "./chatContextModel";
import "../fleet/fleet.css";
import "../people/people.css";

export function ChatPanels({ context, active, account, targets, ready, onClose, onConnected, onAsk, onFleet, onPeople, onDirty }: {
  context: ChatContext | null;
  active: boolean;
  account?: ConsoleAccount;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  onClose: () => void;
  onConnected: (target: string) => void;
  onAsk: (action: ConversationAction) => void;
  onFleet: (reference: FleetReference) => void;
  onPeople: (request: PeopleOpenRequest) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const last = useRef<ChatContext>({ kind: "activity" });
  const activity = useRef<Extract<ChatContext, { kind: "activity" }>>({ kind: "activity" });
  const person = useRef<Extract<ChatContext, { kind: "person" }>>({ kind: "person" });
  const files = useRef<Extract<ChatContext, { kind: "files" }>>({ kind: "files" });
  if (context) last.current = context;
  if (context?.kind === "activity") activity.current = context;
  if (context?.kind === "person") person.current = context;
  if (context?.kind === "files") files.current = context;
  const [activityDirty, setActivityDirty] = useState(false);
  const [personDirty, setPersonDirty] = useState(false);
  useLayoutEffect(() => { onDirty(activityDirty || personDirty); }, [activityDirty, personDirty, onDirty]);
  const shown = last.current;
  const open = (kind: ChatContext["kind"]) => active && context?.kind === kind;
  const title = shown.kind === "activity" ? "Ship" : shown.kind === "person" ? "Person" : shown.kind === "files" ? "Reference a file" : "Connect a computer";
  return <FleetDialog className="chat-context-panel" open={active && context !== null} title={title} onClose={onClose}>
    <RetainedView active={open("activity")}><ChatActivity account={account} request={activity.current.request}
      onAsk={onAsk} onFleet={onFleet} onDirty={setActivityDirty} /></RetainedView>
    <RetainedView active={open("person")}><ChatPerson account={account} request={person.current}
      onAsk={onAsk} onPeople={onPeople} onDirty={setPersonDirty} /></RetainedView>
    <RetainedView active={open("files")}><ChatFiles request={files.current} targets={targets} ready={ready}
      allowed={!!account && canConfigure(account, "fs.read")} onAsk={onAsk} /></RetainedView>
    <RetainedView active={open("connect")}><ConnectPlace account={account} targets={targets} ready={ready}
      onClose={onClose} onConnected={onConnected} /></RetainedView>
  </FleetDialog>;
}

function ChatFiles({ request, targets, ready, allowed, onAsk }: {
  request: Extract<ChatContext, { kind: "files" }>;
  targets: readonly ConsoleTarget[];
  ready: boolean;
  allowed: boolean;
  onAsk: (action: ConversationAction) => void;
}) {
  const active = useViewActive();
  const [file, setFile] = useState(request.file);
  useLayoutEffect(() => setFile(request.file), [request]);
  if (!allowed) return <p class="note">Your account cannot read files.</p>;
  const places = orderPlaces([...targets]);
  return <>
    <RetainedView active={active && !file}><div class="fleet-tree">{places.map((place) =>
      <PlaceTree key={place.id} place={place} enabled={ready && place.online} onOpenFile={setFile} />)}</div></RetainedView>
    {file && <>
      <button type="button" class="fleet-text-action chat-context-back" onClick={() => setFile(undefined)}>← files</button>
      <FilePreview file={{ ...file, name: file.path.split("/").filter(Boolean).at(-1) ?? file.path }} enabled={ready}
      placeLabel={places.find((place) => place.id === file.target)?.label ?? file.target}
      onClose={() => setFile(undefined)} onAsk={onAsk} />
    </>}
  </>;
}
