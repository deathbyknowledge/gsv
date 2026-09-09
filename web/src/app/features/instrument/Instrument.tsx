import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { GlyphStars } from "../session/backgrounds/GlyphStars";
import { SessionScreens } from "../session/SessionScreens";
import { useSession } from "../../services/session/SessionProvider";
import { Zen } from "./zen/Zen";
import { FirstDay } from "./firstday/FirstDay";
import { Fleet } from "./fleet/Fleet";
import { Memory } from "./memory/Memory";
import { WireSync } from "./wire/WireSync";
import type { MemoryPageRef } from "./shared/navigation";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "firstday" | "fleet" | "memory";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${string}` | `ledger:${string}` | `more:${string}` | `dir:${string}` | `file:${string}`;

const DISTANCE_TO_PATH = {
  zen: "/zen",
  firstday: "/first-day",
  fleet: "/fleet",
  memory: "/memory",
} satisfies Record<Distance, string>;

const DISTANCES: readonly Distance[] = ["zen", "firstday", "fleet", "memory"];

function distanceForPath(path: string): Distance {
  return DISTANCES.find((distance) => DISTANCE_TO_PATH[distance] === path) ?? "zen";
}

const THEME_KEY = "gsv.instrument.theme";
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
type Theme = "light" | "dark";

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const STAR_DENSITY = { zen: 0.013, firstday: 0.013, fleet: 0.022, memory: 0.010 } satisfies Record<Distance, number>;
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
  const [fleetRow, setFleetRow] = useState<FleetRow | null>(null);
  const [zenPrefill, setZenPrefill] = useState<string | null>(null);
  const [selectedMemoryPage, setSelectedMemoryPage] = useState<MemoryPageRef | null>(null);
  /* the theme follows the system until the person picks one with the l key; the choice is remembered on this device */
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  useEffect(() => {
    if (storedTheme()) return undefined;
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return undefined;
    const follow = () => setTheme(systemTheme());
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
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
  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // a private window or blocked storage: the choice lasts for this page only
      }
      return next;
    });
  }, []);
  /* which process Zen shows: null is the ship; Fleet can open a helper's conversation */
  const [zenPid, setZenPid] = useState<string | null>(null);
  const moving = useRef(false);

  const move = useCallback(
    (to: Distance, row: FleetRow | null = null) => {
      if (moving.current || to === distance) {
        if (row) setFleetRow(row);
        return;
      }
      setFleetRow(row);
      history.replaceState(null, "", DISTANCE_TO_PATH[to]);
      if (reducedMotion()) {
        setDistance(to);
        return;
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
    },
    [distance],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "z") {
        event.preventDefault();
        move(distance === "fleet" ? "zen" : "fleet");
      }
      if (event.key === "n" && distance !== "fleet") {
        event.preventDefault();
        move(distance === "firstday" ? "zen" : "firstday");
      }
      if (event.key === "m") {
        event.preventDefault();
        move(distance === "memory" ? "zen" : "memory");
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
      if (event.key === "Escape" && help) {
        setHelp(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycleScale, distance, help, move, toggleTheme]);

  const phaseClass = phase === "leaving" ? " is-leaving" : phase === "arriving" ? " is-arriving" : "";

  return (
    <div class={`instrument${theme === "light" ? " is-light" : ""}${scale === 1.5 ? " is-scale-15" : scale === 2 ? " is-scale-2" : ""}`}>
      <div class={`instrument-field${distance === "fleet" ? " is-fleet" : ""}`}>
        <GlyphStars density={STAR_DENSITY[distance]} />
      </div>
      <div class="instrument-scan" aria-hidden="true" />
      <WireSync />
      <div class="instrument-vignette" aria-hidden="true" />
      <div class="instrument-scaled">
      {help ? (
        <aside class="instrument-help" aria-label="Keys">
          <h4>Everywhere</h4>
          <dl>
            <dt>z</dt><dd>zen and fleet</dd>
            <dt>n</dt><dd>first day</dd>
            <dt>m</dt><dd>memory</dd>
            <dt>l</dt><dd>light and dark</dd>
            <dt>x</dt><dd>type size</dd>
            <dt>esc</dt><dd>leave the prompt</dd>
          </dl>
          <h4>Zen</h4>
          <dl>
            <dt>$ …</dt><dd>run it yourself, no model</dd>
            <dt>@place</dt><dd>move the prompt</dd>
            <dt>j k</dt><dd>browse moments</dd>
            <dt>o</dt><dd>show the run</dd>
            <dt>y n</dt><dd>answer an approval</dd>
          </dl>
          <h4>Memory</h4>
          <dl>
            <dt>j k</dt><dd>walk the pages</dd>
            <dt>/</dt><dd>search</dd>
            <dt>e</dt><dd>correct a page</dd>
            <dt>⌘ enter</dt><dd>save</dd>
          </dl>
          <h4>Fleet</h4>
          <dl>
            <dt>j k</dt><dd>move</dd>
            <dt>enter</dt><dd>open</dd>
            <dt>/</dt><dd>command on the place</dd>
            <dt>t</dt><dd>plain words or technical</dd>
          </dl>
        </aside>
      ) : null}
      <div class={`distance${phaseClass}`}>
        {distance === "zen" ? (
          <Zen onFleet={(row) => move("fleet", row ?? null)} onFirstDay={() => move("firstday")} onMemory={(page) => {
            if (page) setSelectedMemoryPage(page);
            move("memory");
          }} prefill={zenPrefill} onPrefillUsed={() => setZenPrefill(null)} pid={zenPid} onShip={() => setZenPid(null)} />
        ) : distance === "firstday" ? (
          <FirstDay onZen={() => move("zen")} />
        ) : distance === "memory" ? (
          <Memory initialPage={selectedMemoryPage} onZen={() => move("zen")} onFleet={() => move("fleet")} onAsk={(page, prompt) => {
            setSelectedMemoryPage(page);
            setZenPid(null);
            setZenPrefill(prompt);
            move("zen");
          }} />
        ) : (
          <Fleet
            onMemory={() => move("memory")}
            initialRow={fleetRow}
            onZen={(prefill, pid) => {
              if (prefill) setZenPrefill(prefill);
              setZenPid(pid ?? null);
              move("zen");
            }}
          />
        )}
      </div>
      </div>
    </div>
  );
}
