import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar, type AvatarStatus } from "./Avatar";
import { Select } from "./Select";
import { Segmented } from "./Segmented";
import "./AgentCard.css";

export interface AgentTask {
  name: string;
  /** "running" | "error" | "idle" (anything not error/idle reads as running). */
  status: string;
}

export interface AgentCardProps {
  agentName?: string;
  agentRole?: string;
  description?: string;
  imgSrc?: string;
  status?: AvatarStatus;
  modelIsDefault?: boolean;
  initialModel?: string;
  initialPermission?: string;
  tasksTotal?: number;
  active?: boolean;
  showActions?: boolean;
  saved?: boolean;
  readOnly?: boolean;
  /** Model dropdown options. */
  models?: string[];
  /** Tasks list (each with a per-row status dot). */
  tasks?: AgentTask[];
  onManage?: () => void;
  onSwitch?: () => void;
  onClose?: () => void;
  onSave?: () => void;
  onAvatarClick?: () => void;
}

const PERMS = ["auto", "ask", "deny"];

const DEFAULT_MODELS = ["Nemotron 3", "Claude Opus 4", "GPT-5", "Llama 4 Maverick"];
const DEFAULT_TASKS: AgentTask[] = [
  { name: "No active tasks", status: "idle" },
];

const MONO = "var(--gsv-font-mono)";

function dotFor(st: string): preact.JSX.CSSProperties {
  const c = st === "error" ? "var(--error)" : st === "idle" ? "var(--idle)" : "var(--online)";
  return {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flex: "none",
    display: "inline-block",
    background: c,
    boxShadow: st !== "idle" ? `0 0 7px ${c}` : undefined,
  };
}
function colFor(st: string): string {
  return st === "error" ? "var(--error)" : st === "idle" ? "#9a95cf" : "var(--online)";
}

function modelIndexForValue(value: string | undefined, options: readonly string[]): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return 0;
  }
  const index = options.findIndex((option) => option.trim() === trimmed);
  return index >= 0 ? index : 0;
}

function permissionForValue(value: string | undefined): string {
  if (value === "allow") {
    return "auto";
  }
  return PERMS.includes(value ?? "") ? value as string : "ask";
}

/** AgentCard — ported from Agent Card.dc.html. Crew-member card composing
 *  Avatar (status), Select (model), and Segmented (tool permissions), with an
 *  inline tasks dropdown that renders per-row status dots. */
export function AgentCard(props: AgentCardProps) {
  const {
    agentName = "Agent",
    agentRole = "AGENT",
    description = "No agent details available.",
    imgSrc = "/img/agent-0.png",
    status = "online",
    modelIsDefault = true,
    initialModel,
    initialPermission,
    tasksTotal,
    active = true,
    showActions = true,
    saved = false,
    readOnly = false,
    models = DEFAULT_MODELS,
    tasks = DEFAULT_TASKS,
    onManage,
    onSwitch,
    onClose,
    onSave,
    onAvatarClick,
  } = props;
  const modelOptions = models.length > 0 ? models : DEFAULT_MODELS;
  const modelOptionsKey = modelOptions.join("\u0000");

  const [perm, setPerm] = useState(() => permissionForValue(initialPermission));
  const [model, setModel] = useState(() => modelIndexForValue(initialModel, modelOptions));
  const [task, setTask] = useState(0);
  const [taskOpen, setTaskOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const saveT = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setTaskOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      clearTimeout(saveT.current);
    };
  }, []);

  useEffect(() => {
    setPerm(permissionForValue(initialPermission));
    setModel(modelIndexForValue(initialModel, modelOptions));
  }, [initialModel, initialPermission, modelOptionsKey]);

  const flashSaved = () => {
    onSave?.();
    clearTimeout(saveT.current);
    setSavedFlash(true);
    saveT.current = window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const showSwitch = !active && showActions;
  const showClose = active && showActions;
  const visibleTasks = tasks.length > 0 ? tasks : DEFAULT_TASKS;
  const resolvedTasksTotal = tasksTotal ?? (tasks.length > 0 ? tasks.length : 0);

  const headerStyle: preact.JSX.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "13px",
    padding: "15px 16px",
    borderBottom: "1px solid var(--border)",
    ...(active || !showActions
      ? { background: "#0c0a24" }
      : {
          background: "rgba(224,166,76,.13)",
          boxShadow: "inset 0 0 0 1.5px rgba(224,166,76,.55),0 0 18px rgba(224,166,76,.12)",
        }),
  };

  const permVal = PERMS.indexOf(perm) < 0 ? 1 : PERMS.indexOf(perm);
  const onPerm = (i: number) => {
    if (readOnly) return;
    setPerm(PERMS[i] || "ask");
    flashSaved();
  };
  const onModel = (i: number) => {
    if (readOnly) return;
    setModel(i);
    flashSaved();
  };

  const cur = visibleTasks[task] || visibleTasks[0];
  const isSaved = savedFlash || saved;

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        background: "var(--panel)",
        overflow: "visible",
        fontFamily: "'Space Grotesk',system-ui,sans-serif",
        color: "#cdd2e0",
        width: "100%",
      }}
    >
      {/* header */}
      <div style={headerStyle}>
        <div onClick={onAvatarClick} class="gsv-ac-fade" style={{ position: "relative", flex: "none", cursor: "pointer" }}>
          <Avatar src={imgSrc} status={status} size={44} />
        </div>
        <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "baseline", gap: "9px", flexWrap: "wrap" }}>
          <span
            onClick={onAvatarClick}
            class="gsv-ac-fade"
            style={{
              fontFamily: MONO,
              fontWeight: 700,
              fontSize: "17px",
              letterSpacing: ".06em",
              color: "var(--text-hi)",
              textShadow: "0 0 7px rgba(150,140,255,.4)",
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            {agentName}
          </span>
          <span style={{ fontFamily: MONO, fontSize: "9.5px", letterSpacing: ".16em", color: "#8f8ac0" }}>{agentRole}</span>
        </div>
        {showSwitch ? (
          <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "7px" }}>
            <span
              style={{ display: "flex", color: "var(--warn)", cursor: "pointer", filter: "drop-shadow(0 0 5px rgba(224,166,76,.45))" }}
              onClick={onSwitch}
            >
              <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="square">
                <path d="M2 5 H12" />
                <path d="M9 2.4 L12 5 L9 7.6" />
                <path d="M14 11 H4" />
                <path d="M7 8.4 L4 11 L7 13.6" />
              </svg>
            </span>
            <span
              onClick={onSwitch}
              class="gsv-ac-switch"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: "9.5px",
                letterSpacing: ".14em",
                color: "var(--warn)",
                borderBottom: "1px solid var(--warn)",
              }}
            >
              SWITCH
              <svg width="7" height="9" viewBox="0 0 9 12" style={{ display: "block" }}>
                <path d="M0 0 L9 6 L0 12 Z" fill="currentColor" />
              </svg>
            </span>
          </div>
        ) : null}
        {showClose ? (
          <span
            onClick={onClose}
            class="gsv-ac-close"
            style={{
              flex: "none",
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: "13px",
              lineHeight: 1,
              color: "var(--text-dim)",
              alignSelf: "flex-start",
            }}
          >
            {"✕"}
          </span>
        ) : null}
      </div>

      {/* body */}
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "18px" }}>
        {/* description */}
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "11.5px", lineHeight: "1.65", color: "#a8a2dc" }}>
          {description}
        </div>

        {/* model */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginBottom: "9px",
              fontFamily: MONO,
              fontSize: "10px",
              letterSpacing: ".18em",
              color: "var(--label)",
            }}
          >
            <span>MODEL</span>
            {modelIsDefault ? (
              <span style={{ color: "var(--live)", letterSpacing: ".1em" }}>
                (<span style={{ borderBottom: "1px solid var(--live)" }}>AI DEFAULT</span>)
              </span>
            ) : null}
          </div>
          <Select options={modelOptions} value={model} onChange={onModel} width={560} disabled={readOnly} />
        </div>

        {/* tool permissions */}
        <div>
          <div style={{ marginBottom: "9px", fontFamily: MONO, fontSize: "10px", letterSpacing: ".18em", color: "var(--label)" }}>
            TOOL PERMISSIONS
          </div>
          <Segmented l0="ALLOW" l1="ASK" l2="DENY" value={permVal} onChange={onPerm} width={220} disabled={readOnly} />
        </div>

        {/* tasks */}
        <div>
          <div style={{ marginBottom: "9px", fontFamily: MONO, fontSize: "10px", letterSpacing: ".18em", color: "var(--label)" }}>
            TASKS ({resolvedTasksTotal})
          </div>
          <div style={{ position: "relative" }}>
            <div
              onClick={() => setTaskOpen((o) => !o)}
              class="gsv-ac-taskbtn"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "9px",
                border: "1px solid var(--border)",
                background: "var(--panel-2)",
                padding: "10px 12px",
                cursor: "pointer",
                transition: "background .12s",
              }}
            >
              <span style={dotFor(cur.status)} />
              <span style={{ fontFamily: MONO, fontSize: "11.5px", letterSpacing: ".03em", color: "var(--text)" }}>{cur.name}</span>
              <span style={{ marginLeft: "auto", display: "flex" }}>
                <svg width="9" height="6" viewBox="0 0 9 6" style={{ display: "block" }}>
                  <path d="M0 0 L9 0 L4.5 6 Z" fill="var(--accent)" />
                </svg>
              </span>
            </div>
            {taskOpen ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: "100%",
                  marginTop: "4px",
                  zIndex: 40,
                  background: "var(--header-bar)",
                  border: "1px solid var(--border-raised)",
                  boxShadow: "0 12px 30px rgba(0,0,0,.55)",
                  maxHeight: "184px",
                  overflowY: "auto",
                }}
              >
                {visibleTasks.map((t, i) => (
                  <div
                    onClick={() => {
                      setTask(i);
                      setTaskOpen(false);
                      if (!readOnly) {
                        flashSaved();
                      }
                    }}
                    class="gsv-ac-taskrow"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "9px",
                      padding: "10px 12px",
                      cursor: "pointer",
                      transition: "background .12s",
                      ...(i === task ? { background: "var(--hover)" } : {}),
                    }}
                  >
                    <span style={dotFor(t.status)} />
                    <span style={{ fontFamily: MONO, fontSize: "11px", letterSpacing: ".03em", color: "var(--text)", minWidth: 0, flex: 1 }}>
                      {t.name}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: "8.5px", letterSpacing: ".14em", color: colFor(t.status) }}>
                      {t.status.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* manage */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "-2px" }}>
          {isSaved ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontFamily: MONO, fontSize: "10px", letterSpacing: ".16em", color: "var(--online)" }}>
              {"✓"} SAVED
            </span>
          ) : (
            <span />
          )}
          <span
            onClick={onManage}
            class="gsv-ac-manage"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "7px",
              cursor: "pointer",
              fontFamily: MONO,
              fontSize: "10px",
              letterSpacing: ".16em",
              color: "var(--accent)",
              borderBottom: "1px solid var(--accent)",
              paddingBottom: "1px",
            }}
          >
            MANAGE
            <svg width="8" height="11" viewBox="0 0 9 12" style={{ display: "block", filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
              <path d="M0 0 L9 6 L0 12 Z" fill="currentColor" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
