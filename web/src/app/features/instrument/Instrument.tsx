import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { GlyphStars } from "../session/backgrounds/GlyphStars";
import { SessionScreens } from "../session/SessionScreens";
import { useSession } from "../../services/session/SessionProvider";
import { Zen } from "./zen/Zen";
import { FirstDay } from "./firstday/FirstDay";
import { Fleet } from "./fleet/Fleet";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "firstday" | "fleet";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${string}`;

const DISTANCE_TO_PATH = {
  zen: "/zen",
  firstday: "/first-day",
  fleet: "/fleet",
} satisfies Record<Distance, string>;

const DISTANCES: readonly Distance[] = ["zen", "firstday", "fleet"];

function distanceForPath(path: string): Distance {
  return DISTANCES.find((distance) => DISTANCE_TO_PATH[distance] === path) ?? "zen";
}

const THEME_KEY = "gsv.instrument.theme";
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

const STAR_DENSITY = { zen: 0.013, firstday: 0.013, fleet: 0.022 } satisfies Record<Distance, number>;
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
      if (event.key === "l") {
        event.preventDefault();
        toggleTheme();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [distance, move, toggleTheme]);

  const phaseClass = phase === "leaving" ? " is-leaving" : phase === "arriving" ? " is-arriving" : "";

  return (
    <div class={`instrument${theme === "light" ? " is-light" : ""}`}>
      <div class={`instrument-field${distance === "fleet" ? " is-fleet" : ""}`}>
        <GlyphStars density={STAR_DENSITY[distance]} />
      </div>
      <div class="instrument-scan" aria-hidden="true" />
      <div class="instrument-vignette" aria-hidden="true" />
      <div class={`distance${phaseClass}`}>
        {distance === "zen" ? (
          <Zen onFleet={(row) => move("fleet", row ?? null)} onFirstDay={() => move("firstday")} prefill={zenPrefill} onPrefillUsed={() => setZenPrefill(null)} pid={zenPid} onShip={() => setZenPid(null)} />
        ) : distance === "firstday" ? (
          <FirstDay onZen={() => move("zen")} />
        ) : (
          <Fleet
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
  );
}
