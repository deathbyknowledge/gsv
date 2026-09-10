import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useColorTheme } from "../../components/ui/useColorTheme";
import { GlyphStars } from "../session/backgrounds/GlyphStars";
import { SessionScreens } from "../session/SessionScreens";
import { useSession } from "../../services/session/SessionProvider";
import { Zen } from "./zen/Zen";
import { Fleet } from "./fleet/Fleet";
import { Memory } from "./memory/Memory";
import { Settings } from "./settings/Settings";
import type { FleetReference } from "./fleet/fleetModel";
import { WireSync } from "./wire/WireSync";
import type { MemoryPageRef } from "./shared/navigation";
import { InstrumentHeader } from "./shared/InstrumentHeader";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "fleet" | "memory" | "settings";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${string}` | `ledger:${string}` | `contact:${string}` | `work:${string}` | `routine:${string}` | `more:${string}` | `dir:${string}` | `file:${string}`;

const DISTANCE_TO_PATH = {
  zen: "/zen",
  fleet: "/fleet",
  memory: "/memory",
  settings: "/zen/settings",
} satisfies Record<Distance, string>;

const DISTANCES: readonly Distance[] = ["zen", "fleet", "memory", "settings"];

function distanceForPath(path: string): Distance {
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
const STAR_DENSITY = 0.013;
const MOVE_MS = 150;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** The instrument behind the session gate: the sign-in screens own the galaxy until the session is ready. */
export function Instrument({ initialPath }: { initialPath: string }) {
  const { service, snapshot } = useSession();
  if (snapshot.phase !== "ready") {
    return <SessionScreens session={service} snapshot={snapshot} />;
  }
  return <InstrumentReady initialPath={initialPath} />;
}

function InstrumentReady({ initialPath }: { initialPath: string }) {
  const [distance, setDistance] = useState<Distance>(() => distanceForPath(initialPath));
  const [phase, setPhase] = useState<"still" | "leaving" | "arriving">("still");
  const [fleetReference, setFleetReference] = useState<FleetReference | null>(null);
  const [zenPrefill, setZenPrefill] = useState<string | null>(null);
  const [selectedMemoryPage, setSelectedMemoryPage] = useState<MemoryPageRef | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [zenDirty, setZenDirty] = useState(false);
  const [fleetDirty, setFleetDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [zenTarget, setZenTarget] = useState<string | null>(null);
  /* the theme follows the system until the person picks one with the l key; the choice is remembered on this device */
  const { theme, toggleTheme } = useColorTheme();
  const [scale, setScale] = useState<Scale>(() => storedScale());
  const [help, setHelp] = useState(false);
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
  const moving = useRef(false);

  const move = useCallback(
    (to: Distance, reference: FleetReference | null = null) => {
      if (moving.current) return false;
      if (to === distance) {
        if (reference) setFleetReference(reference);
        return true;
      }
      if (settingsDirty && !window.confirm("Discard your unsaved settings changes?")) return false;
      if (zenDirty && !window.confirm("Discard your unsent message and attachments?")) return false;
      if (fleetDirty && !window.confirm("Discard your unsaved Fleet changes?")) return false;
      if (memoryDirty && !window.confirm("Discard your unsaved Memory changes?")) return false;
      setSettingsDirty(false);
      setZenDirty(false);
      setFleetDirty(false);
      setMemoryDirty(false);
      setFleetReference(reference);
      history.replaceState(null, "", DISTANCE_TO_PATH[to]);
      if (reducedMotion()) {
        setDistance(to);
        return true;
      }
      moving.current = true;
      setPhase("leaving");
      window.setTimeout(() => {
        setDistance(to);
        setPhase("arriving");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setPhase("still");
            moving.current = false;
          }),
        );
      }, MOVE_MS);
      return true;
    },
    [distance, settingsDirty, zenDirty, fleetDirty, memoryDirty],
  );

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (target instanceof HTMLElement && target.closest(".fleet-connection, .settings-model-editor")) return;
      if (event.defaultPrevented || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "z") {
        event.preventDefault();
        move(distance === "fleet" ? "zen" : "fleet");
      }
      if (event.key === "m") {
        event.preventDefault();
        move(distance === "memory" ? "zen" : "memory");
      }
      if (event.key === ",") {
        event.preventDefault();
        move(distance === "settings" ? "zen" : "settings");
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
  }, [cycleScale, distance, move, toggleTheme]);

  const phaseClass = phase === "leaving" ? " is-leaving" : phase === "arriving" ? " is-arriving" : "";

  return (
    <div class={`instrument${theme === "light" ? " is-light" : ""}${scale === 1.5 ? " is-scale-15" : scale === 2 ? " is-scale-2" : ""}`}>
      <div class="instrument-field">
        <GlyphStars density={STAR_DENSITY} />
      </div>
      <div class="instrument-scan" aria-hidden="true" />
      <WireSync />
      <div class="instrument-vignette" aria-hidden="true" />
      <div class="instrument-scaled">
      <InstrumentHeader distance={distance} onNavigate={move} helper={distance === "zen" && zenPid !== null}
        onShip={() => {
          if (!zenDirty || window.confirm("Discard your unsent message and attachments?")) setZenPid(null);
        }} help={help} onHelp={() => setHelp((open) => !open)} />
      {help ? (
        <aside id="instrument-help" class="instrument-help" aria-label="Keys">
          <h4>Views & appearance</h4>
          <p>Navigation shortcuts work outside text fields and setup forms.</p>
          <dl>
            <dt>z</dt><dd>Fleet · press again to return to Zen</dd>
            <dt>m</dt><dd>Memory · press again to return to Zen</dd>
            <dt>,</dt><dd>Settings · press again to return to Zen</dd>
            <dt>l</dt><dd>Switch between light and dark</dd>
            <dt>x</dt><dd>Cycle text size</dd>
            <dt>?</dt><dd>Show or hide these shortcuts</dd>
            <dt>Esc</dt><dd>Close this panel</dd>
          </dl>
          {distance === "zen" && <>
            <h4>Zen · browse</h4>
            <dl>
              <dt>i</dt><dd>Start typing in the prompt</dd>
              <dt>j / ↓</dt><dd>Next message or activity</dd>
              <dt>k / ↑</dt><dd>Previous message or activity</dd>
              <dt>o</dt><dd>Show or hide the selected message’s activity</dd>
              <dt>y / n</dt><dd>Approve or deny a pending request</dd>
            </dl>
            <h4>Zen · input</h4>
            <dl>
              <dt>Enter</dt><dd>Send the message or run the command</dd>
              <dt>Shift + Enter</dt><dd>New line</dd>
              <dt>Esc</dt><dd>Return to browse; closes the place picker first</dd>
              <dt>↑</dt><dd>Recall the last input when the prompt is empty</dd>
              <dt>@place</dt><dd>Choose a target with ↑ ↓ and Enter</dd>
              <dt>$ command</dt><dd>Run a shell command on that target, without the model</dd>
            </dl>
          </>}
          {distance === "memory" && <>
            <h4>Memory</h4>
            <dl>
              <dt>j / ↓</dt><dd>Open the next page</dd>
              <dt>k / ↑</dt><dd>Open the previous page</dd>
              <dt>/</dt><dd>Focus page search</dd>
              <dt>e</dt><dd>Edit the open page</dd>
              <dt>⌘ / Ctrl + Enter</dt><dd>Save while editing page text</dd>
              <dt>Esc</dt><dd>Leave search or close the editor</dd>
            </dl>
          </>}
          {distance === "fleet" && <>
            <h4>Fleet</h4>
            <dl>
              <dt>j / ↓</dt><dd>Select the next row</dd>
              <dt>k / ↑</dt><dd>Select the previous row</dd>
              <dt>Enter</dt><dd>Open a file or folder; otherwise focus the inspector’s main action</dd>
              <dt>/</dt><dd>Open a command prompt for the selected place</dd>
              <dt>t</dt><dd>Switch between human labels and technical details</dd>
            </dl>
            <h4>Expanded file</h4>
            <dl>
              <dt>⌘ / Ctrl + Enter</dt><dd>Save file edits</dd>
              <dt>Esc</dt><dd>Return to Fleet</dd>
            </dl>
            <h4>Contact messages</h4>
            <dl>
              <dt>Enter</dt><dd>Send the message</dd>
              <dt>Shift + Enter</dt><dd>New line</dd>
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
      <div class={`distance${phaseClass}`}>
        {distance === "zen" ? (
          <Zen key={zenPid ?? "ship"} onDraftChange={setZenDirty} onFleet={(reference) => move("fleet", reference ?? null)} onMemory={(page) => {
            if (!move("memory")) return;
            if (page) setSelectedMemoryPage(page);
          }} initialTarget={zenTarget} prefill={zenPrefill} onPrefillUsed={() => setZenPrefill(null)} pid={zenPid} />
        ) : distance === "memory" ? (
          <Memory onDirtyChange={setMemoryDirty} initialPage={selectedMemoryPage} onAsk={(page, prompt) => {
            if (!move("zen")) return;
            setSelectedMemoryPage(page);
            setZenPid(null);
            setZenTarget(null);
            setZenPrefill(prompt);
          }} />
        ) : distance === "settings" ? (
          <Settings onDirtyChange={setSettingsDirty} />
        ) : (
          <Fleet
            onCommand={(target) => { if (move("zen")) { setZenTarget(target); setZenPrefill("$ "); setZenPid(null); } }}
            onDirtyChange={setFleetDirty}
            initialReference={fleetReference}
            onZen={(prefill, pid) => {
              if (!move("zen")) return;
              setZenTarget(null);
              setZenPrefill(prefill ?? null);
              setZenPid(pid ?? null);
            }}
          />
        )}
      </div>
      </div>
    </div>
  );
}
