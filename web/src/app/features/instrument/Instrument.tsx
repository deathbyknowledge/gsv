import type { ActivityRequest } from "./zen/chatContextModel";
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
import { People } from "./people/People";
import { peoplePath, readPeopleRoute } from "./people/peopleNavigation";
import { usePeopleActivity } from "./people/usePeopleActivity";
import type { FleetReference } from "./fleet/fleetModel";
import { WireSync } from "./wire/WireSync";
import { replaceLegacyChatPath, type MemoryPageRef } from "./shared/navigation";
import { InstrumentHeader } from "./shared/InstrumentHeader";
import { WelcomeCard } from "./shared/WelcomeCard";
import { SHELL_KEYS } from "./shared/shellKeys";
import { useDismissOnOutsideClick } from "./shared/useDismissOnOutsideClick";
import { useTabAttention } from "./shared/useTabAttention";
import { useInstrumentViewport } from "./shared/useInstrumentViewport";
import { useScrollEdges } from "./shared/useScrollEdges";
import { RetainedView } from "../../services/navigation/ViewActivity";
import { navigateApp } from "../../services/navigation/appNavigation";
import { ClientControlError, useClientControl } from "../../services/platform/ClientControl";
import { useGateway } from "../../services/gateway/GatewayProvider";
import { trackClientActivity } from "../../services/gateway/clientActivity";
import { NativeVoiceSession } from "../../services/platform/NativeVoiceSession";
import { HandsfreeStatus } from "../../services/platform/HandsfreeStatus";
import { ApprovalPrompt } from "./shared/ApprovalToast";
import { useT } from "../../i18n/locale";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "fleet" | "memory" | "settings" | "people";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${string}` | `more:${string}` | `dir:${string}` | `file:${string}`;

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
  const [handsfreeDirty, setHandsfreeDirty] = useState(false);
  const { service, snapshot } = useSession();
  const { status } = useGateway();
  useClientControl(["status"], async () => ({ type: "status", status: {
    gateway: status.state === "connecting" ? "connecting" : "disconnected", window: "visible", selectedProcess: null,
  } }), snapshot.phase !== "ready");
  if (snapshot.phase !== "ready") {
    return <SessionScreens session={service} snapshot={snapshot} />;
  }
  return <TerminalProvider key={JSON.stringify([snapshot.url, snapshot.username])}><DevicePairingProvider><BrowserControlProvider>
    <NativeVoiceSession onDirtyChange={setHandsfreeDirty}><InstrumentReady initialPath={initialPath} handsfreeDirty={handsfreeDirty} /></NativeVoiceSession>
  </BrowserControlProvider></DevicePairingProvider></TerminalProvider>;
}

function InstrumentReady({ initialPath, handsfreeDirty }: { initialPath: string; handsfreeDirty: boolean }) {
  const t = useT();
  const viewportRef = useInstrumentViewport();
  const { service: session } = useSession();
  const { client, status } = useGateway();
  useEffect(() => {
    if (status.state !== "connected") return;
    return trackClientActivity(document, (signal) => {
      // Activity is disposable if the socket closes before the next render.
      try { client.sendSignal(signal); } catch { /* The next input after reconnect reports activity. */ }
    });
  }, [client, status.state]);
  const distance = distanceForPath(initialPath);
  const visitedPaths = useRef<Partial<Record<Distance, string>>>({});
  visitedPaths.current[distance] = distance === "people" ? peoplePath(readPeopleRoute(window.location.search))
    : distance === "settings" ? `/chat/settings${window.location.search}` : DISTANCE_TO_PATH[distance];
  const scrollEdgesRef = useScrollEdges(distance);
  useEffect(() => {
    replaceLegacyChatPath();
  }, [initialPath]);
  const [fleetRequest, setFleetRequest] = useState<FleetProps["openRequest"]>(null);
  const [zenPrefill, setZenPrefill] = useState<string | null>(null);
  const [selectedMemoryPage, setSelectedMemoryPage] = useState<MemoryPageRef | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [zenDirty, setZenDirty] = useState(false);
  /* the founders' welcome still stands over the chat; Ship is not waking until it is dismissed */
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const [fleetDirty, setFleetDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [peopleDirty, setPeopleDirty] = useState(false);
  const [zenTarget, setZenTarget] = useState<string | null>(null);
  /* the theme follows the system until the person picks one with the l key; the choice is remembered on this device */
  const { theme, toggleTheme } = useColorTheme("light");
  /* the tab title and favicon carry Ship's messages while the person is looking elsewhere */
  useTabAttention();
  const [scale, setScale] = useState<Scale>(() => storedScale());
  const [help, setHelp] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchRequested, setSearchRequested] = useState(false);
  const helpRef = useRef<HTMLElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
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
  const [activityRequest, setActivityRequest] = useState<ActivityRequest>();
  const [zenRequestPrefill, setZenRequestPrefill] = useState<string | null>(null);
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
      navigateApp("/chat");
      return { type: command.type === "new" ? "created" : "selected", processId: pid };
    } finally { selectingProcess.current = false; }
  });

  const peopleActivity = usePeopleActivity(viewer);
  const move = useCallback(
    (to: Distance, reference: FleetReference | null = null) => {
      if (reference && fleetDirty && !window.confirm(t("shell.confirm.discardFleetEdits"))) return false;
      setNavigationOpen(false);
      if (to === distance) {
        if (reference) setFleetRequest({ reference });
        return true;
      }
      if (reference) setFleetRequest({ reference });
      navigateApp(visitedPaths.current[to] ?? DISTANCE_TO_PATH[to]);
      return true;
    },
    [distance, fleetDirty, t],
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

  useDismissOnOutsideClick(navigationOpen, () => [navigationRef.current, navigationButtonRef.current], () => setNavigationOpen(false));
  useLayoutEffect(() => {
    if (!navigationOpen) return;
    const dismissNavigation = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setNavigationOpen(false);
      navigationButtonRef.current?.focus();
    };
    window.addEventListener("keydown", dismissNavigation, true);
    return () => window.removeEventListener("keydown", dismissNavigation, true);
  }, [navigationOpen]);

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
        setNavigationOpen(false);
        setHelp((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleScale, move, openSearch, status.state, toggleTheme]);

  return (
    <div ref={viewportRef} class={`instrument${theme === "light" ? " is-light" : ""}${scale === 1.5 ? " is-scale-15" : scale === 2 ? " is-scale-2" : ""}`}>
      <InstrumentBackdrop />
      <WireSync />
      <div class="instrument-viewport">
      <div class="instrument-scaled">
      <div class="instrument-corner">
        <HandsfreeStatus />
        <ApprovalPrompt onOpen={({ process, request }) => {
          if (!process.personal) { move("fleet", { kind: "approval", pid: process.pid, requestId: request.requestId }); return; }
          if (zenPid && zenDirty && !window.confirm(t("shell.confirm.returnToShip"))) return;
          if (!move("zen")) return;
          setZenPid(null);
        }} />
      </div>
      <InstrumentHeader distance={distance} onNavigate={(to) => {
        if (move(to) && navigationOpen) navigationButtonRef.current?.focus();
      }} peopleWaiting={peopleActivity.conversations.length > 0 || peopleActivity.requests.length > 0}
        helper={distance === "zen" && zenPid !== null}
        onShip={() => {
          if (!zenDirty || window.confirm(t("shell.confirm.discardMessage"))) setZenPid(null);
        }} help={help} onHelp={() => {
          setNavigationOpen(false);
          setHelp((open) => !open);
          if (navigationOpen) navigationButtonRef.current?.focus();
        }} helpButtonRef={helpButtonRef} navigationOpen={navigationOpen} navigationRef={navigationRef}
        navigationButtonRef={navigationButtonRef} onNavigationToggle={() => {
          setHelp(false);
          setNavigationOpen((open) => !open);
        }} />
      <WelcomeCard onOpenChange={setWelcomeOpen} />
      {help ? (
        <aside id="instrument-help" class="instrument-help" aria-label={t("shell.help.label")} ref={helpRef}>
          <button type="button" class="instrument-help-search" disabled={status.state !== "connected"} aria-keyshortcuts="Control+K" onClick={openSearch}>
            <span>{t("shell.help.search")}</span><kbd>Ctrl+K</kbd>
          </button>
          <h4>{t("shell.help.views")}</h4>
          <p>{t("shell.help.viewsHint")}</p>
          <dl>
            <dt>c</dt><dd>Chat</dd>
            <dt>f</dt><dd>{t("shell.help.work")}</dd>
            <dt>m</dt><dd>{t("shell.help.memory")}</dd>
            <dt>p</dt><dd>{t("shell.help.people")}</dd>
            <dt>s</dt><dd>{t("settings.title")}</dd>
            <dt>l</dt><dd>{t("shell.help.theme")}</dd>
            <dt>x</dt><dd>{t("shell.help.textSize")}</dd>
            <dt>?</dt><dd>{t("shell.help.toggle")}</dd>
            <dt>Esc</dt><dd>{t("shell.help.closePanel")}</dd>
          </dl>
          {distance === "zen" && <>
            <h4>{t("shell.help.chatBrowse")}</h4>
            <dl>
              <dt>j / k</dt><dd>{t("shell.help.nextPrevious")}</dd>
              <dt>gg / G</dt><dd>{t("shell.help.history")}</dd>
              <dt>o</dt><dd>{t("shell.help.activity")}</dd>
              <dt>/</dt><dd>{t("shell.help.browseSearch")}</dd>
              <dt>y / n</dt><dd>{t("shell.help.approve")}</dd>
              <dt>{t("shell.help.otherKeys")}</dt><dd>{t("shell.help.startWriting")}</dd>
            </dl>
            <h4>{t("shell.help.chatInput")}</h4>
            <dl>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.send")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.returnToBrowse")}</dd>
              <dt>↑</dt><dd>{t("shell.help.recall")}</dd>
              <dt>{t("shell.help.placeSyntax")}</dt><dd>{t("shell.help.chooseTarget")}</dd>
              <dt>{t("shell.help.commandSyntax")}</dt><dd>{t("shell.help.runCommand")}</dd>
            </dl>
          </>}
          {distance === "memory" && <>
            <h4>{t("shell.help.memory")}</h4>
            <dl>
              <dt>j / ↓</dt><dd>{t("shell.help.nextItem")}</dd>
              <dt>k / ↑</dt><dd>{t("shell.help.previousItem")}</dd>
              <dt>{t("shell.keys.spaceOrEnter")}</dt><dd>{t("shell.help.openPage")}</dd>
              <dt>/</dt><dd>{t("shell.help.pageSearch")}</dd>
              <dt>e</dt><dd>{t("shell.help.editPage")}</dd>
              <dt>{t("shell.keys.save")}</dt><dd>{t("shell.help.savePage")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.leaveSearch")}</dd>
            </dl>
          </>}
          {distance === "fleet" && <>
            <h4>{t("shell.help.work")}</h4>
            <dl>
              <dt>j / ↓</dt><dd>{t("shell.help.nextRow")}</dd>
              <dt>k / ↑</dt><dd>{t("shell.help.previousRow")}</dd>
              <dt>{t("shell.keys.spaceOrEnter")}</dt><dd>{t("shell.help.openItem")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.closeInspector")}</dd>
              <dt>/</dt><dd>{t("shell.help.commandPrompt")}</dd>
            </dl>
            <h4>{t("shell.help.expandedFile")}</h4>
            <dl>
              <dt>{t("shell.keys.save")}</dt><dd>{t("shell.help.saveFile")}</dd>
              <dt>Esc</dt><dd>{t("shell.help.returnToFleet")}</dd>
            </dl>
            <h4>{t("shell.help.contactMessages")}</h4>
            <dl>
              <dt>{t("shell.keys.enter")}</dt><dd>{t("shell.help.sendMessage")}</dd>
            </dl>
          </>}
          {distance === "settings" && <>
            <h4>{t("settings.title")}</h4>
            <dl>
              <dt>{t("shell.keys.tab")}</dt><dd>{t("shell.help.moveControls")}</dd>
              <dt>{t("shell.keys.enterOrSpace")}</dt><dd>{t("shell.help.activate")}</dd>
            </dl>
          </>}
        </aside>
      ) : null}
      <div class="distance" data-view={distance} ref={scrollEdgesRef}>
        <BrowserControlOverlay />
        <RetainedView active={distance === "zen"}>
          <Zen key={zenPid ?? "ship"} searchRequested={searchRequested} onSearchRequestHandled={() => setSearchRequested(false)} onDraftChange={setZenDirty} onFleet={(reference) => move("fleet", reference ?? null)} onMemory={(page) => {
            if (page && memoryDirty && !window.confirm(t("shell.confirm.discardPage"))) return;
            if (!move("memory")) return;
            if (page) setSelectedMemoryPage({ ...page });
          }} initialTarget={zenTarget} prefill={zenPrefill} requestPrefill={zenRequestPrefill} activityRequest={activityRequest}
          onPrefillUsed={() => { setZenPrefill(null); setZenRequestPrefill(null); }} pid={zenPid} welcomeOpen={welcomeOpen}
          contactReplies={zenPid ? undefined : contactReplies}
          peopleActivity={zenPid ? undefined : peopleActivity}
          onPeopleActivity={(request) => {
            /* a contact conversation Zen asked People to open; a fresh object each time so the same contact reopens */
            if (!request) { move("people"); return; }
            navigateApp(peoplePath("contactId" in request ? { contactId: request.contactId } : { view: "requests", requestId: request.requestId }));
          }} />
        </RetainedView>
        <RetainedView active={distance === "memory"}>
          <Memory onDirtyChange={setMemoryDirty} initialPage={selectedMemoryPage} onAsk={(text) => {
            if (zenPid && zenDirty && !window.confirm(t("shell.confirm.returnToShip"))) return;
            if (!move("zen")) return;
            setZenPid(null);
            setZenTarget(null);
            setZenPrefill(null); setZenRequestPrefill(text);
          }} />
        </RetainedView>
        <RetainedView active={distance === "settings"}>
          <Settings onDirtyChange={setSettingsDirty} onInspectProcess={(pid) => { move("fleet", `proc:${pid}`); }} onSignOut={() => {
            if ((handsfreeDirty || settingsDirty || unsaved || fleetDirty || memoryDirty || peopleDirty) && !window.confirm(t("shell.confirm.signOut"))) return;
            void session.lock("session.status.signedOut");
          }} />
        </RetainedView>
        <RetainedView active={distance === "people"}>
          <People onDirtyChange={setPeopleDirty} onAsk={(text) => {
            if (zenPid && zenDirty && !window.confirm(t("shell.confirm.returnToShip"))) return;
            if (!move("zen")) return;
            setZenPid(null); setZenTarget(null); setZenPrefill(null); setZenRequestPrefill(text);
          }} />
        </RetainedView>
        <RetainedView active={distance === "fleet"}>
          <Fleet
            onActivity={(request) => { if (move("zen")) setActivityRequest(request); }}
            onCommand={(target) => {
              if (zenDirty && !window.confirm(t("shell.confirm.replaceWithCommand"))) return;
              if (move("zen")) { setZenTarget(target); setZenPrefill("$ "); setZenPid(null); }
            }}
            onDirtyChange={setFleetDirty}
            openRequest={fleetRequest}
            onZen={(prefill, pid, request) => {
              if ((Boolean(prefill) || (pid ?? null) !== zenPid) && zenDirty && !window.confirm(t("shell.confirm.discardMessage"))) return;
              if (!move("zen")) return;
              if (prefill || (pid ?? null) !== zenPid) setZenTarget(null);
              if (prefill) setZenPrefill(prefill);
              if (request) setZenRequestPrefill(request);
              setZenPid(pid ?? null);
            }}
          />
        </RetainedView>
      </div>
      </div>
      </div>
    </div>
  );
}
