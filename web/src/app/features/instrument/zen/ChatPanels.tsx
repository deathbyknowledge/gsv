import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ConsoleAccount, ConsoleTarget } from "../../../domain/system/consoleModels";
import { RetainedView } from "../../../services/navigation/ViewActivity";
import { FleetDialog } from "../fleet/FleetDialog";
import { ConnectPlace } from "../fleet/ConnectPlace";
import { orderPlaces, type FleetReference } from "../fleet/fleetModel";
import { PlaceTree } from "../shared/PlaceFiles";
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
} satisfies Record<ChatContext["kind"], TextKey>;

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
  if (context) last.current = context;
  if (context?.kind === "activity") activity.current = context;
  if (context?.kind === "person") person.current = context;
  const [activityDirty, setActivityDirty] = useState(false);
  const [personDirty, setPersonDirty] = useState(false);
  useLayoutEffect(() => { onDirty(activityDirty || personDirty); }, [activityDirty, personDirty, onDirty]);
  const shown = last.current;
  const open = (kind: ChatContext["kind"]) => active && context?.kind === kind;
  return <FleetDialog className={`chat-context-panel is-${shown.kind}`} open={active && context !== null} title={t(TITLES[shown.kind])} onClose={onClose}>
    <RetainedView active={open("activity")}><ChatActivity account={account} request={activity.current.request}
      onAsk={onAsk} onFleet={onFleet} onDirty={setActivityDirty} /></RetainedView>
    <RetainedView active={open("person")}><ChatPerson account={account} request={person.current}
      onAsk={onAsk} onPeople={onPeople} onDirty={setPersonDirty} /></RetainedView>
    <RetainedView active={open("files")}><ChatFiles targets={targets} ready={ready}
      allowed={!!account && canConfigure(account, "fs.read")} onAsk={onAsk} /></RetainedView>
    <RetainedView active={open("connect")}><ConnectPlace account={account} targets={targets} ready={ready}
      onClose={onClose} onConnected={onConnected} /></RetainedView>
  </FleetDialog>;
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
