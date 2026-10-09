import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useColorTheme } from "../../components/ui/useColorTheme";
import { InstrumentBackdrop } from "./shared/InstrumentBackdrop";
import { SessionScreens } from "../session/SessionScreens";
import { useSession } from "../../services/session/SessionProvider";
import { TerminalProvider } from "../../services/terminal/TerminalProvider";
import { DevicePairingProvider } from "../../services/machines/DevicePairingProvider";
import { Zen } from "./zen/Zen";
import { useContactReplies } from "./people/useContactReplies";
import { useConsoleAccounts } from "../../services/system/useConsoleData";
import { Fleet, type FleetProps } from "./fleet/Fleet";
import { BrowserControlProvider, BrowserControlOverlay } from "./browser/BrowserControl";
import { Memory } from "./memory/Memory";
import { Settings } from "./settings/Settings";
import { People, type PeopleOpenRequest } from "./people/People";
import { usePeopleActivity } from "./people/usePeopleActivity";
import type { FleetReference } from "./fleet/fleetModel";
import { WireSync } from "./wire/WireSync";
import { replaceLegacyChatPath, type MemoryPageRef } from "./shared/navigation";
import { InstrumentHeader } from "./shared/InstrumentHeader";
import { SHELL_KEYS } from "./shared/shellKeys";
import { useDismissOnOutsideClick } from "./shared/useDismissOnOutsideClick";
import { useTabAttention } from "./shared/useTabAttention";
import { RetainedView } from "../../services/navigation/ViewActivity";
import { ClientControlError, useClientControl } from "../../services/platform/ClientControl";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { trackClientActivity } from "../../services/gateway/clientActivity";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "fleet" | "memory" | "settings" | "people";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${string}` | `work:${string}` | `routine:${string}` | `more:${string}` | `dir:${string}` | `file:${string}`;

const DISTANCE_TO_PATH = {
  zen: "/chat",
  fleet: "/fleet",
  memory: "/memory",
  settings: "/chat/settings",
  people: "/people",
} satisfies Record<Distance, string>;

const DISTANCES: readonly Distance[] = ["zen", "fleet", "memory", "settings", "people"];

function distanceForPath(path: string): Distance {
  if (path === "/zen/settings") return "settings";
  return DISTANCES.find((distance) => DISTANCE_TO_PATH[distance] === path) ?? "zen";
}

const SCALE_KEY = "gsv.instrument.scale";
const SCALES = [1, 1.5, 2] as const;
type Scale = (typeof SCALES)[number];

function storedScale(): Scale {
  try {
    const value = Number(window.localStorage.getItem(SCALE_KEY));
    return SCALES.find((scale) => scale === value) ?? 1;
  } catch {
    return 1;
  }
}
/** The instrument behind the session gate: the sign-in screens own the galaxy until the session is ready. */
export function Instrument({ initialPath }: { initialPath: string }) {
  const { service, snapshot } = useSession();
  const { status } = useGateway();
  useClientControl(["status"], async () => ({ type: "status", status: {
    gateway: status.state === "connecting" ? "connecting" : "disconnected", window: "visible", selectedProcess: null,
  } }), snapshot.phase !== "ready");
  if (snapshot.phase !== "ready") {
    return <SessionScreens session={service} snapshot={snapshot} />;
  }
  return <TerminalProvider key={JSON.stringify([snapshot.url, snapshot.username])}><DevicePairingProvider><BrowserControlProvider><InstrumentReady initialPath={initialPath} /></BrowserControlProvider></DevicePairingProvider></TerminalProvider>;
}

function InstrumentReady({ initialPath }: { initialPath: string }) {
  const { service: session } = useSession();
  const { client, status } = useGateway();
  useEffect(() => {
    if (status.state !== "connected") return;
    return trackClientActivity(document, (signal) => {
      // Activity is disposable if the socket closes before the next render.
      try { client.sendSignal(signal); } catch { /* The next input after reconnect reports activity. */ }
    });
  }, [client, status.state]);
  const [distance, setDistance] = useState<Distance>(() => distanceForPath(initialPath));
  useEffect(() => {
    replaceLegacyChatPath();
  }, [initialPath]);
  const [fleetRequest, setFleetRequest] = useState<FleetProps["openRequest"]>(null);
  const [zenPrefill, setZenPrefill] = useState<string | null>(null);
  const [selectedMemoryPage, setSelectedMemoryPage] = useState<MemoryPageRef | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [zenDirty, setZenDirty] = useState(false);
  const [fleetDirty, setFleetDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [peopleDirty, setPeopleDirty] = useState(false);
  const [settingsEntry, setSettingsEntry] = useState<{ section: "profile" } | null>(null);
  const [zenTarget, setZenTarget] = useState<string | null>(null);
  /* the theme follows the system until the person picks one with the l key; the choice is remembered on this device */
  const { theme, toggleTheme } = useColorTheme();
  /* the tab title and favicon carry Ship's messages while the person is looking elsewhere */
  useTabAttention();
  const [scale, setScale] = useState<Scale>(() => storedScale());
  const [help, setHelp] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  const helpRef = useRef<HTMLElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const cycleScale = useCallback(() => {
    setScale((current) => {
      const next = SCALES[(SCALES.indexOf(current) + 1) % SCALES.length];
      try {
        window.localStorage.setItem(SCALE_KEY, String(next));
      } catch {
        // storage blocked: the choice lasts for this page only
      }
      return next;
    });
  }, []);
  /* which process Zen shows: null is the ship; Fleet can open a helper's conversation */
  const [zenPid, setZenPid] = useState<string | null>(null);
  /* Ship's contact notices live here, above the keyed Zen view, so opening a helper and coming back keeps them */
  const accounts = useConsoleAccounts();
  const viewer = accounts.data?.find((account) => account.relation === "self");
  const contactReplies = useContactReplies(viewer);
  /* unsaved work the instrument guards as a whole: the chat's prompt, and replies typed under Ship's notices even while a helper is shown */
  const unsaved = zenDirty || contactReplies.dirty;
  const selectingProcess = useRef(false);
  const controlState = useRef({ unsaved });
  controlState.current = { unsaved };
  useClientControl(["status", "new", "use"], async ({ command, checkpoint, signal }) => {
    if (command.type === "status") return { type: "status", status: {
      gateway: status.state === "connected" ? "connected" : status.state === "connecting" ? "connecting" : "disconnected",
      window: "visible", selectedProcess: zenPid,
    } };
    if (unsaved || selectingProcess.current) throw new ClientControlError("busy");
    if (status.state !== "connected") throw new ClientControlError("unavailable");
    selectingProcess.current = true;
    try {
      await checkpoint();
      let pid: string;
      if (command.type === "new") {
        const { data: result } = await client.request("proc.spawn", { interactive: true, label: "Desktop" }, { signal });
        if (!result.ok) throw new ClientControlError("permissionDenied");
        pid = result.pid;
      } else if (command.type === "use") {
        const { data: result } = await client.request("proc.list", {}, { signal });
        if (!result.processes.some((process) => process.pid === command.processId)) throw new ClientControlError("processNotFound");
        pid = command.processId;
      } else throw new ClientControlError("unavailable");
      await checkpoint();
      if (controlState.current.unsaved) throw new ClientControlError("busy");
      setZenPid(pid);
      setDistance("zen");
      history.replaceState(null, "", "/chat");
      return { type: command.type === "new" ? "created" : "selected", processId: pid };
    } finally { selectingProcess.current = false; }
  });

  /* a contact conversation Zen asked People to open; a fresh object each time so the same contact reopens */
  const [peopleRequest, setPeopleRequest] = useState<PeopleOpenRequest | null>(null);
  const peopleActivity = usePeopleActivity(viewer);
  const move = useCallback(
    (to: Distance, reference: FleetReference | null = null) => {
      if (reference && fleetDirty && !window.confirm("Discard unsaved Fleet edits and open this item?")) return false;
      if (to === distance) {
        if (reference) setFleetRequest({ reference });
        return true;
      }
      if (reference) setFleetRequest({ reference });
      history.replaceState(null, "", DISTANCE_TO_PATH[to]);
      setDistance(to);
      return true;
    },
    [distance, fleetDirty],
  );

  const openSearch = useCallback(() => {
    if (status.state !== "connected") return;
    move("zen");
    setHelp(false);
    setSearchRequested(true);
  }, [move, status.state]);

  useLayoutEffect(() => {
    if (!help) return;
    const dismissHelp = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setHelp(false);
    };
    window.addEventListener("keydown", dismissHelp, true);
    return () => window.removeEventListener("keydown", dismissHelp, true);
  }, [help]);
  /* a press anywhere else closes the keys; the panel and its button do not */
  useDismissOnOutsideClick(help, () => [helpRef.current, helpButtonRef.current], () => setHelp(false));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (event.defaultPrevented || event.isComposing) return;
      if (target instanceof HTMLElement && target.closest(".zen-search-dialog")) return;
      if (event.key === "k" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && status.state === "connected") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (target instanceof HTMLElement && target.closest(".fleet-connection, .settings-model-editor")) return;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!SHELL_KEYS.has(event.key)) return;
      if (event.key === "c") {
        event.preventDefault();
        move("zen");
      }
      if (event.key === "f") {
        event.preventDefault();
        move("fleet");
      }
      if (event.key === "m") {
        event.preventDefault();
        move("memory");
      }
      if (event.key === "p") {
        event.preventDefault();
        move("people");
      }
      if (event.key === "s") {
        event.preventDefault();
        move("settings");
      }
      if (event.key === "l") {
        event.preventDefault();
        toggleTheme();
      }
      if (event.key === "x") {
        event.preventDefault();
        cycleScale();
      }
      if (event.key === "?") {
        event.preventDefault();
        setHelp((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleScale, move, openSearch, status.state, toggleTheme]);

  return (
    <div class={`instrument${theme === "light" ? " is-light" : ""}${scale === 1.5 ? " is-scale-15" : scale === 2 ? " is-scale-2" : ""}`}>
      <InstrumentBackdrop />
      <WireSync />
      <div class="instrument-scaled">
      <InstrumentHeader distance={distance} onNavigate={move} peopleWaiting={peopleActivity.conversations.length > 0 || peopleActivity.requests.length > 0} helper={distance === "zen" && zenPid !== null}
        onShip={() => {
          if (!zenDirty || window.confirm("Discard your unsent message and attachments?")) setZenPid(null);
        }} help={help} onHelp={() => setHelp((open) => !open)} helpButtonRef={helpButtonRef} />
      {help ? (
        <aside id="instrument-help" class="instrument-help" aria-label="Help" ref={helpRef}>
          <button type="button" class="instrument-help-search" disabled={status.state !== "connected"} aria-keyshortcuts="Control+K" onClick={openSearch}>
            <span>Search Chat</span><kbd>Ctrl+K</kbd>
          </button>
          <h4>Views & appearance</h4>
          <p>Navigation shortcuts work outside text fields and setup forms.</p>
          <dl>
            <dt>c</dt><dd>Chat</dd>
            <dt>f</dt><dd>Fleet</dd>
            <dt>m</dt><dd>Memory</dd>
            <dt>p</dt><dd>People</dd>
            <dt>s</dt><dd>Settings</dd>
            <dt>l</dt><dd>Switch between light and dark</dd>
            <dt>x</dt><dd>Cycle text size</dd>
            <dt>?</dt><dd>Show or hide these shortcuts</dd>
            <dt>Esc</dt><dd>Close this panel</dd>
          </dl>
          {distance === "zen" && <>
            <h4>Chat · browse</h4>
            <dl>
              <dt>j / k</dt><dd>Next / previous message or activity</dd>
              <dt>gg / G</dt><dd>Earlier history / latest messages and follow</dd>
              <dt>o</dt><dd>Show or hide the selected message’s activity</dd>
              <dt>/</dt><dd>Search in browse mode · Ctrl/Cmd+F also works</dd>
              <dt>y / n</dt><dd>Approve or deny a pending request</dd>
              <dt>other keys</dt><dd>Start writing; the keystroke lands in the prompt</dd>
            </dl>
            <h4>Chat · input</h4>
            <dl>
              <dt>Enter</dt><dd>Send the message or run the command</dd>
              <dt>Esc</dt><dd>Return to browse; closes the place picker first</dd>
              <dt>↑</dt><dd>Recall the last input when the prompt is empty</dd>
              <dt>@place</dt><dd>Choose a target with ↑ ↓ and Enter</dd>
              <dt>$ command</dt><dd>Run a shell command on that target, without the model</dd>
            </dl>
          </>}
          {distance === "memory" && <>
            <h4>Memory</h4>
            <dl>
              <dt>j / ↓</dt><dd>Highlight the next visible item</dd>
              <dt>k / ↑</dt><dd>Highlight the previous visible item</dd>
              <dt>Space / Enter</dt><dd>Open the highlighted page or toggle its folder</dd>
              <dt>/</dt><dd>Focus page search</dd>
              <dt>e</dt><dd>Edit the open page</dd>
              <dt>⌘ / Ctrl + Enter</dt><dd>Save while editing page text</dd>
              <dt>Esc</dt><dd>Leave search or close the editor</dd>
            </dl>
          </>}
          {distance === "fleet" && <>
            <h4>Fleet</h4>
            <dl>
              <dt>j / ↓</dt><dd>Highlight the next row</dd>
              <dt>k / ↑</dt><dd>Highlight the previous row</dd>
              <dt>Space / Enter</dt><dd>Open the highlighted item or toggle a folder</dd>
              <dt>Esc</dt><dd>Close the inspector</dd>
              <dt>/</dt><dd>Open a command prompt for the highlighted place</dd>
            </dl>
            <h4>Expanded file</h4>
            <dl>
              <dt>⌘ / Ctrl + Enter</dt><dd>Save file edits</dd>
              <dt>Esc</dt><dd>Return to Fleet</dd>
            </dl>
            <h4>Contact messages</h4>
            <dl>
              <dt>Enter</dt><dd>Send the message</dd>
            </dl>
          </>}
          {distance === "settings" && <>
            <h4>Settings</h4>
            <dl>
              <dt>Tab / Shift + Tab</dt><dd>Move between controls</dd>
              <dt>Enter / Space</dt><dd>Activate the focused button</dd>
            </dl>
          </>}
        </aside>
      ) : null}
      <div class="distance" data-view={distance}>
        <BrowserControlOverlay />
        <RetainedView active={distance === "zen"}>
          <Zen key={zenPid ?? "ship"} searchRequested={searchRequested} onSearchRequestHandled={() => setSearchRequested(false)} onDraftChange={setZenDirty} onFleet={(reference) => move("fleet", reference ?? null)} onMemory={(page) => {
            if (page && memoryDirty && !window.confirm("Discard your unsaved page changes and open this page?")) return;
            if (!move("memory")) return;
            if (page) setSelectedMemoryPage({ ...page });
          }} initialTarget={zenTarget} prefill={zenPrefill} onPrefillUsed={() => setZenPrefill(null)} pid={zenPid}
          contactReplies={zenPid ? undefined : contactReplies}
          peopleActivity={zenPid ? undefined : peopleActivity}
          onPeopleActivity={(request) => { if (move("people") && request) setPeopleRequest(request); }} />
        </RetainedView>
        <RetainedView active={distance === "memory"}>
          <Memory onDirtyChange={setMemoryDirty} initialPage={selectedMemoryPage} onAsk={(_page, prompt) => {
            if (zenDirty && !window.confirm("Replace your unsent message and attachments with this question?")) return;
            if (!move("zen")) return;
            setZenPid(null);
            setZenTarget(null);
            setZenPrefill(prompt);
          }} />
        </RetainedView>
        <RetainedView active={distance === "settings"}>
          <Settings openRequest={settingsEntry} onDirtyChange={setSettingsDirty} onInspectProcess={(pid) => { move("fleet", `proc:${pid}`); }} onSignOut={() => {
            if ((settingsDirty || unsaved || fleetDirty || memoryDirty || peopleDirty) && !window.confirm("Discard your unsaved work and sign out?")) return;
            void session.lock("Signed out");
          }} />
        </RetainedView>
        <RetainedView active={distance === "people"}>
          <People onDirtyChange={setPeopleDirty} openRequest={peopleRequest} onProfile={() => { if (move("settings")) setSettingsEntry({ section: "profile" }); }} onAsk={(prompt) => {
            if (zenDirty && !window.confirm("Replace your unsent message and attachments with this request?")) return;
            if (!move("zen")) return;
            setZenPid(null); setZenTarget(null); setZenPrefill(prompt);
          }} />
        </RetainedView>
        <RetainedView active={distance === "fleet"}>
          <Fleet
            onCommand={(target) => {
              if (zenDirty && !window.confirm("Replace your unsent message and attachments with a command?")) return;
              if (move("zen")) { setZenTarget(target); setZenPrefill("$ "); setZenPid(null); }
            }}
            onDirtyChange={setFleetDirty}
            openRequest={fleetRequest}
            onZen={(prefill, pid) => {
              if ((Boolean(prefill) || (pid ?? null) !== zenPid) && zenDirty && !window.confirm("Discard your unsent message and attachments?")) return;
              if (!move("zen")) return;
              if (prefill || (pid ?? null) !== zenPid) setZenTarget(null);
              if (prefill) setZenPrefill(prefill);
              setZenPid(pid ?? null);
            }}
          />
        </RetainedView>
      </div>
      </div>
    </div>
  );
}
