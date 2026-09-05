import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { GlyphStars } from "../session/backgrounds/GlyphStars";
import { Zen } from "./zen/Zen";
import { FirstDay } from "./firstday/FirstDay";
import { Fleet } from "./fleet/Fleet";
import "./instrument.css";

/** The three distances of the instrument. Zen is near, Fleet is far, the first day is Zen's empty state. */
export type Distance = "zen" | "firstday" | "fleet";

/** A row in Fleet, addressed the way the manifest addresses it: `target:<id>` or `proc:<pid>`. */
export type FleetRow = `target:${string}` | `proc:${number}`;

const PATH_TO_DISTANCE: Record<string, Distance> = {
  "/zen": "zen",
  "/first-day": "firstday",
  "/fleet": "fleet",
};
const DISTANCE_TO_PATH: Record<Distance, string> = {
  zen: "/zen",
  firstday: "/first-day",
  fleet: "/fleet",
};

const STAR_DENSITY: Record<Distance, number> = { zen: 0.013, firstday: 0.013, fleet: 0.022 };
const MOVE_MS = 150;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function Instrument({ initialPath }: { initialPath: string }) {
  const [distance, setDistance] = useState<Distance>(PATH_TO_DISTANCE[initialPath] ?? "zen");
  const [phase, setPhase] = useState<"still" | "leaving" | "arriving">("still");
  const [fleetRow, setFleetRow] = useState<FleetRow | null>(null);
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
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "z") {
        event.preventDefault();
        move(distance === "fleet" ? "zen" : "fleet");
      }
      if (event.key === "n" && distance !== "fleet") {
        event.preventDefault();
        move(distance === "firstday" ? "zen" : "firstday");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [distance, move]);

  const phaseClass = phase === "leaving" ? " is-leaving" : phase === "arriving" ? " is-arriving" : "";

  return (
    <div class="instrument">
      <div class={`instrument-field${distance === "fleet" ? " is-fleet" : ""}`}>
        <GlyphStars density={STAR_DENSITY[distance]} />
      </div>
      <div class="instrument-scan" aria-hidden="true" />
      <div class="instrument-vignette" aria-hidden="true" />
      <div class={`distance${phaseClass}`}>
        {distance === "zen" ? (
          <Zen onFleet={(row) => move("fleet", row ?? null)} onFirstDay={() => move("firstday")} />
        ) : distance === "firstday" ? (
          <FirstDay onZen={() => move("zen")} />
        ) : (
          <Fleet initialRow={fleetRow} onZen={() => move("zen")} />
        )}
      </div>
    </div>
  );
}
