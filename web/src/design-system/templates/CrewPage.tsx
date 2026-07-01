import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { AgentCard } from "../../app/components/ui/AgentCard";

const MONO = "var(--gsv-font-mono)";

export interface CrewPageProps {
  /** Override the measured container width (drives the narrow < 720px layout). */
  containerWidth?: number;
  onNew?: () => void;
  onManage?: (name: string) => void;
  onBack?: () => void;
}

interface SeedAgent {
  name: string;
  role: string;
  desc: string;
  img: string;
  modelDefault: boolean;
  tasksTotal: number;
  active: boolean;
  running: boolean;
}

// Verbatim from the source DATA0.
const DATA0: SeedAgent[] = [
  {
    name: "Xanadu",
    role: "PERSONAL AGENT",
    desc: "Default agent — first crew of GSV. Your right hand, here for whatever you need.",
    img: "img/agent-0.png",
    modelDefault: true,
    tasksTotal: 23,
    active: true,
    running: true,
  },
  {
    name: "Liger",
    role: "RESEARCH AGENT",
    desc: "Digs through the library and the web. Summarises, cross-references, keeps the index warm.",
    img: "img/agent-1.png",
    modelDefault: true,
    tasksTotal: 0,
    active: false,
    running: false,
  },
  {
    name: "Bob",
    role: "OPS AGENT",
    desc: "Watches the machines and runs the heavy jobs. Currently recovering from a crashed task.",
    img: "img/agent-2.png",
    modelDefault: false,
    tasksTotal: 4,
    active: false,
    running: false,
  },
];

/** CrewPage — ported from "Crew Page.dc.html". Console page on var(--void) with
 *  a glyph-grid background texture, a back + breadcrumb top bar, and a panel
 *  whose section-header bar caps a responsive grid of AgentCards closed by a
 *  dashed NEW AGENT tile. Below 720px the layout collapses to a single column. */
export function CrewPage({ containerWidth, onNew, onManage, onBack }: CrewPageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    if (containerWidth != null) return;
    const el = rootRef.current;
    if (!el) return;
    const update = () => setMeasured(el.clientWidth);
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [containerWidth]);

  const W = containerWidth != null ? containerWidth : measured || 1100;
  const narrow = W < 720;

  const goManage = (name: string) => onManage?.(name);
  const goNew = () => onNew?.();
  const goBack = () => onBack?.();

  const crewCount = DATA0.length;
  const runningCount = DATA0.filter((a) => a.running).length;

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        minHeight: "100%",
        background: "var(--void)",
        fontFamily: MONO,
        color: "#cdd2e0",
        padding: 0,
        overflow: "hidden",
      }}
    >
      {/* glyph universe texture */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
          backgroundImage:
            "linear-gradient(rgba(150,140,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(150,140,255,.04) 1px,transparent 1px)",
          backgroundSize: "46px 46px",
        }}
      />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, fontFamily: MONO }}>
        <span style={{ position: "absolute", left: "16%", top: "13%", fontSize: "13px", color: "#b6b1ff", opacity: 0.16 }}>
          {"✦"}
        </span>
        <span style={{ position: "absolute", left: "62%", top: "8%", fontSize: "15px", color: "#cdd5e6", opacity: 0.18 }}>
          {"∗"}
        </span>
        <span style={{ position: "absolute", left: "85%", top: "30%", fontSize: "11px", color: "#b6b1ff", opacity: 0.16 }}>
          {"·"}
        </span>
        <span style={{ position: "absolute", left: "40%", top: "52%", fontSize: "10px", color: "#cdd5e6", opacity: 0.2 }}>
          {"◦"}
        </span>
        <span style={{ position: "absolute", left: "22%", top: "78%", fontSize: "12px", color: "#b6b1ff", opacity: 0.14 }}>
          {"✦"}
        </span>
        <span style={{ position: "absolute", left: "74%", top: "82%", fontSize: "13px", color: "#cdd5e6", opacity: 0.16 }}>
          {"∗"}
        </span>
        <span style={{ position: "absolute", left: "92%", top: "66%", fontSize: "9px", color: "#cdd5e6", opacity: 0.22 }}>
          {"◦"}
        </span>
      </div>

      <div style={{ position: "relative", zIndex: 2 }}>
        {/* top bar */}
        <div
          style={{
            position: "relative",
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            ...(narrow
              ? { gap: "12px", padding: "16px 16px" }
              : { gap: "18px", padding: "22px 30px" }),
          }}
        >
          <span
            onClick={goBack}
            class="gsv-crew-back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "38px",
              height: "38px",
              flex: "none",
              cursor: "pointer",
              color: "var(--accent)",
              border: "1px solid var(--border)",
              background: "var(--panel-2)",
              transition: "background .12s",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
              <path d="M9.5 3.5 L5 8 L9.5 12.5" />
              <path d="M5 8 H13" />
            </svg>
          </span>
          <div class="gsv-listitem" style={{ display: "flex", alignItems: "center", gap: "10px", letterSpacing: ".18em" }}>
            <span class="gsv-crew-crumb" style={{ color: "var(--text-dim)", cursor: "pointer" }}>
              GSV
            </span>
            <span style={{ color: "var(--rule-section)" }}>{"›"}</span>
            <span class="gsv-crew-crumb" style={{ color: "var(--text-dim)", cursor: "pointer" }}>
              SETTINGS
            </span>
            <span style={{ color: "var(--rule-section)" }}>{"›"}</span>
            <span style={{ color: "var(--text-hi)", textShadow: "0 0 7px rgba(150,140,255,.45)" }}>CREW</span>
          </div>
        </div>

        {/* panel */}
        <div
          style={{
            position: "relative",
            zIndex: 2,
            borderTop: "1px solid var(--border)",
            minHeight: narrow ? "480px" : "560px",
          }}
        >
          {/* section header bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "11px",
              padding: "14px 20px",
              borderBottom: "1px solid var(--border)",
              background: "var(--header-bar)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                flex: "none",
                borderRadius: "1px",
                background: "var(--accent)",
                boxShadow: "0 0 8px var(--accent)",
              }}
            />
            <span
              class="gsv-section"
              style={{
                color: "var(--text-title)",
                textShadow: "0 0 5px rgba(150,140,255,.3)",
              }}
            >
              CREW
            </span>
            <span class="gsv-sublabel" style={{ marginLeft: "auto", letterSpacing: ".16em", color: "#7d78b8" }}>
              {crewCount} AGENTS {"·"} {runningCount} RUNNING
            </span>
          </div>

          {/* agent card grid */}
          <div
            style={
              narrow
                ? { padding: "16px", display: "grid", gridTemplateColumns: "1fr", gap: "16px", alignItems: "start" }
                : {
                    padding: "26px",
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(312px,1fr))",
                    gap: "22px",
                    alignItems: "start",
                  }
            }
          >
            {DATA0.map((a) => (
              <div key={a.name} style={{ border: "1px solid var(--border)", boxShadow: "0 0 22px rgba(60,52,150,.12)" }}>
                <AgentCard
                  agentName={a.name}
                  agentRole={a.role}
                  description={a.desc}
                  imgSrc={a.img}
                  modelIsDefault={a.modelDefault}
                  tasksTotal={a.tasksTotal}
                  active={true}
                  showActions={false}
                  onManage={() => goManage(a.name)}
                />
              </div>
            ))}

            {/* NEW AGENT tile */}
            <div
              onClick={goNew}
              class="gsv-crew-newtile"
              style={{
                minHeight: "430px",
                border: "1px dashed var(--border-raised)",
                background: "var(--panel)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "18px",
                cursor: "pointer",
                transition: "background .15s,border-color .15s",
              }}
            >
              <div
                style={{
                  width: "54px",
                  height: "54px",
                  border: "1px dashed var(--dashed)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                }}
              >
                <svg width="26" height="26" viewBox="0 0 16 16" shape-rendering="crispEdges">
                  <g fill="currentColor">
                    <rect x="7" y="2" width="2" height="12" />
                    <rect x="2" y="7" width="12" height="2" />
                  </g>
                </svg>
              </div>
              <div class="gsv-label" style={{ letterSpacing: ".2em", color: "var(--text-title)" }}>NEW AGENT</div>
              <div
                class="gsv-sublabel"
                style={{
                  letterSpacing: ".1em",
                  color: "#7d78b8",
                  maxWidth: "200px",
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                Spin up a new crew member with its own persona &amp; files
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
