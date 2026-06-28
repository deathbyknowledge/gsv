import { useEffect, useRef, useState } from "preact/hooks";
import "./AgentEditor.css";
import { TextInput } from "./TextInput";
import { TextArea } from "./TextArea";
import { Select } from "./Select";
import { Segmented } from "./Segmented";
import { Button } from "./Button";
import { Avatar, type AvatarStatus } from "./Avatar";
import { Tabs } from "./Tabs";
import { ConfirmModal } from "./ConfirmModal";
import { useUnsavedGuard } from "../../features/gsv-shell/unsaved/unsavedGuard";

export type AgentEditorMode = "new" | "manage";

export interface AgentEditorProps {
  mode?: AgentEditorMode;
  avatarSrc?: string;
  /** Fill the avatar tile edge-to-edge (full-frame portrait). */
  avatarCover?: boolean;
  containerWidth?: number;
  initialName?: string;
  initialRole?: string;
  initialDescription?: string;
  createdLabel?: string;
  metaLabel?: string;
  status?: AvatarStatus;
  models?: string[];
  initialModel?: string;
  initialPermission?: string;
  files?: AgentEditorFile[];
  tasks?: AgentEditorTask[];
  readOnly?: boolean;
  generalReadOnly?: boolean;
  identityReadOnly?: boolean;
  behaviorReadOnly?: boolean;
  filesReadOnly?: boolean;
  onCreate?: (draft: AgentEditorDraft) => Promise<void> | void;
  onSave?: (draft: AgentEditorDraft) => Promise<void> | void;
}

type TaskStatus = "running" | "error" | "idle" | "online";

export interface AgentEditorFile {
  label: string;
  name?: string;
  content: string;
  orig?: string;
}

export interface AgentEditorDraft {
  name: string;
  role: string;
  description: string;
  model: string;
  modelIndex: number;
  permission: string;
  files: AgentEditorFile[];
}

export interface AgentEditorTask {
  name: string;
  status: TaskStatus;
}

interface Defaults {
  name: string;
  role: string;
  desc: string;
  created: string;
  metaLabel: string;
  status: AvatarStatus;
  model: number;
  perm: string;
  files: AgentEditorFile[];
  tasks: AgentEditorTask[];
}

const MODELS = ["INHERIT DEFAULT", "GATEWAY DEFAULT", "FAST MODEL", "DEEP MODEL"];
const PERMS = ["auto", "ask", "deny"];

function modelIndexForValue(value: string | undefined, options: readonly string[] | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return 0;
  }
  const modelOptions = options && options.length > 0 ? options : MODELS;
  const index = modelOptions.findIndex((option) => option.trim() === trimmed);
  return index >= 0 ? index : 0;
}

function permissionForValue(value: string | undefined): string {
  if (value === "allow") {
    return "auto";
  }
  return PERMS.includes(value ?? "") ? value as string : "ask";
}

function defaults(mode: AgentEditorMode, props: AgentEditorProps): Defaults {
  const files = props.files && props.files.length > 0 ? props.files : null;
  const tasks = props.tasks && props.tasks.length > 0 ? props.tasks : null;

  if (mode === "manage") {
    return {
      name: props.initialName ?? "Primary Agent",
      role: props.initialRole ?? "PRIMARY AGENT",
      desc: props.initialDescription ?? "Primary GSV crew member. Manage identity, operating notes, model, and tool permissions here.",
      created: props.createdLabel ?? "ACTIVE",
      metaLabel: props.metaLabel ?? "CREATED:",
      status: props.status ?? "online",
      model: modelIndexForValue(props.initialModel, props.models),
      perm: permissionForValue(props.initialPermission),
      files: files ?? [
        {
          label: "PERSONA",
          content:
            "# Persona\n\nDescribe this agent's operating role, communication style, responsibilities, and boundaries. This file is loaded at the start of every session.",
        },
        {
          label: "ABOUT USER",
          content:
            "# About the user\n\nCapture durable preferences, working style, and context this agent should keep in mind.",
        },
        {
          label: "ACTIVE PROJECTS",
          content:
            "# Active projects\n\nTrack projects this agent is expected to support.",
        },
      ],
      tasks: tasks ?? [
        { name: "No active task data", status: "idle" },
      ],
    };
  }
  return {
    name: props.initialName ?? "",
    role: props.initialRole ?? "",
    desc: props.initialDescription ?? "",
    created: props.createdLabel ?? "-",
    metaLabel: props.metaLabel ?? "CREATED:",
    status: props.status ?? "idle",
    model: modelIndexForValue(props.initialModel, props.models),
    perm: permissionForValue(props.initialPermission),
    files: files ?? [
      {
        label: "PERSONA",
        content:
          "# Persona\n\n*You are a new agent aboard GSV.*\n\nDescribe who this agent is, how they speak, and what they care about. This file is loaded at the start of every session.",
      },
      {
        label: "ABOUT USER",
        content:
          "# About the user\n\nWho they are, how they like to work, and anything the agent should always keep in mind.",
      },
    ],
    tasks: tasks ?? [],
  };
}

/** AgentEditor — composite ported from Agent Editor.dc.html. A full agent
 *  authoring surface with GENERAL / FILES / TASKS folder tabs. GENERAL composes
 *  TextInput/TextArea/Select/Segmented/Button atoms; FILES has a raw code editor
 *  (deliberately not a labelled field) + delete-confirm modal. */
export function AgentEditor(props: AgentEditorProps) {
  const { avatarSrc, avatarCover = false, containerWidth } = props;
  const mode: AgentEditorMode = props.mode ?? "new";
  const isNew = mode !== "manage";
  const readOnly = props.readOnly === true;
  const generalReadOnly = props.generalReadOnly ?? readOnly;
  const identityReadOnly = props.identityReadOnly ?? generalReadOnly;
  const behaviorReadOnly = props.behaviorReadOnly ?? generalReadOnly;
  const filesReadOnly = props.filesReadOnly ?? readOnly;
  const modelOptions = props.models && props.models.length > 0 ? props.models : MODELS;

  const metaRef = useRef<Defaults>(defaults(mode, props));
  const meta = metaRef.current;

  const [tab, setTab] = useState<"general" | "files" | "tasks">("general");
  const [fileIdx, setFileIdx] = useState(0);
  const [perm, setPerm] = useState(meta.perm);
  const [model, setModel] = useState(meta.model);
  const [name, setName] = useState(meta.name);
  const [role, setRole] = useState(meta.role);
  const [desc, setDesc] = useState(meta.desc);
  const [files, setFiles] = useState<AgentEditorFile[]>(meta.files.map((f) => ({ ...f, orig: f.orig ?? f.content })));
  const [flash, setFlash] = useState("");
  const [formError, setFormError] = useState("");
  const [pendingAction, setPendingAction] = useState<"create" | "save" | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [w, setW] = useState(0);
  const [formNonce, setFormNonce] = useState(0);

  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    setW(window.innerWidth);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(flashTimer.current);
    };
  }, []);

  const setFlashMsg = (msg: string) => {
    setFormError("");
    setFlash(msg);
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(""), 1800);
  };

  const setErrorMsg = (msg: string) => {
    clearTimeout(flashTimer.current);
    setFlash("");
    setFormError(msg);
  };

  // ---- responsive ----
  const W = containerWidth != null ? containerWidth : w || 1100;
  const narrow = W < 720;

  // ---- folder tabs ----
  const tabOrder: ("general" | "files" | "tasks")[] =
    !isNew && (meta.tasks || []).length > 0 ? ["general", "files", "tasks"] : ["general", "files"];
  const activeIdx = Math.max(0, tabOrder.indexOf(tab));

  // ---- avatar ----
  const imgSrc = avatarSrc ?? "img/agent-0.png";
  const status = meta.status;

  // ---- files ----
  const curFile = files[fileIdx] || files[0] || { label: "", content: "" };

  const setFileContent = (v: string) => {
    setFiles((s) => s.map((f, i) => (i === fileIdx ? { ...f, content: v } : f)));
  };

  // ---- unsaved-changes guard ----
  // Baseline is the initial values captured once in metaRef (see line ~172).
  // Scalars compare against meta.*; files compare body vs per-file `orig`
  // baseline, plus a count check to catch added/removed files.
  const dirty =
    name !== meta.name ||
    role !== meta.role ||
    desc !== meta.desc ||
    model !== meta.model ||
    perm !== meta.perm ||
    files.length !== meta.files.length ||
    files.some(
      (f, i) => f.label !== meta.files[i]?.label || f.content !== (f.orig ?? f.content),
    );
  // Registers the editor's dirty state so the shell ConsoleHeader back/nav (the
  // single source of navigation for this surface) prompts before discarding
  // unsaved edits — the editor no longer renders its own back/breadcrumb.
  useUnsavedGuard(() => dirty);

  // ---- tasks ----
  const dotColorFor = (st: TaskStatus) =>
    st === "error" ? "var(--error)" : st === "idle" ? "var(--idle)" : "var(--online)";
  const colFor = (st: TaskStatus) =>
    st === "error" ? "var(--error)" : st === "idle" ? "#9a95cf" : "var(--online)";
  const TASKS = meta.tasks || [];

  const nameDisplay = name || "NEW AGENT";
  const roleDisplay = role || "UNASSIGNED ROLE";

  const permVal = PERMS.indexOf(perm) < 0 ? 1 : PERMS.indexOf(perm);
  const segWidth = narrow ? 600 : 300;

  // ---- handlers ----
  const onContent = (e: Event) => {
    if (!filesReadOnly) {
      setFileContent((e.target as HTMLTextAreaElement).value);
    }
  };
  const onAddFile = () => {
    if (filesReadOnly) return;
    setFiles((s) => [...s, { label: "UNTITLED", content: "# Untitled\n\n", orig: "# Untitled\n\n" }]);
    setFileIdx(files.length);
    setFlash("");
    setFormError("");
  };
  const onReset = () => {
    if (filesReadOnly) return;
    setFiles((s) =>
      s.map((f, i) => (i === fileIdx ? { ...f, content: f.orig != null ? f.orig : f.content } : f)),
    );
    setFlash("");
    setFormError("");
  };
  const draft = (): AgentEditorDraft => ({
    name,
    role,
    description: desc,
    model: modelOptions[model] ?? "",
    modelIndex: model,
    permission: perm,
    files: files.map((file) => ({ ...file })),
  });
  const errorText = (error: unknown): string => {
    return error instanceof Error ? error.message : error ? String(error) : "Action failed";
  };
  const runAction = async (
    kind: "create" | "save",
    handler: ((draft: AgentEditorDraft) => Promise<void> | void) | undefined,
    successMessage: string,
  ) => {
    if (pendingAction !== null) return;
    if (!handler) {
      setFlashMsg(successMessage);
      return;
    }
    setPendingAction(kind);
    setFormError("");
    setFlash("");
    try {
      await handler(draft());
      setFlashMsg(successMessage);
    } catch (error) {
      setErrorMsg(errorText(error));
    } finally {
      setPendingAction(null);
    }
  };
  const onSave = () => {
    void runAction("save", props.onSave, "✓ SAVED");
  };
  const onCreate = () => {
    void runAction("create", props.onCreate, "✓ AGENT CREATED");
  };
  const onResetGeneral = () => {
    if (identityReadOnly && behaviorReadOnly) return;
    setName(meta.name);
    setRole(meta.role);
    setDesc(meta.desc);
    setModel(meta.model);
    setPerm(meta.perm);
    setFormNonce((n) => n + 1);
    setFormError("");
    setFlash("");
  };

  const delName = curFile.label;
  const onDelete = () => {
    if (!filesReadOnly) setDeleteOpen(true);
  };
  const onCancelDelete = () => setDeleteOpen(false);
  const onConfirmDelete = () => {
    if (filesReadOnly) return;
    setFiles((s) => {
      const next = s.filter((_, i) => i !== fileIdx);
      setFileIdx((idx) => Math.max(0, Math.min(idx, next.length - 1)));
      return next;
    });
    setDeleteOpen(false);
    setFlash("");
    setFormError("");
  };

  // ---- styles ----
  const padStyle = "position:relative;z-index:2;";
  const panelStyle =
    "position:relative;z-index:2;display:flex;flex-direction:column;min-height:" +
    (narrow ? "480px" : "560px") + ";";
  const genWrapStyle = narrow
    ? "display:flex;flex-direction:column;padding:22px 16px 30px;gap:20px;"
    : "display:flex;flex-direction:column;padding:28px 32px 40px;gap:22px;";
  const identityStyle = "order:-1;display:flex;flex-direction:row;align-items:center;gap:16px;width:100%;";
  const secPad = narrow ? "padding:20px 16px 28px;" : "padding:28px 32px 36px;";

  return (
    <div
      class="gsv-ae"
      data-readonly={identityReadOnly && behaviorReadOnly && filesReadOnly ? "true" : undefined}
      style="position:relative;min-height:100vh;background:var(--void);font-family:var(--gsv-font-mono);color:#cdd2e0;padding:0;overflow:visible;"
    >
      {/* glyph universe texture */}
      <div style="position:absolute;inset:0;pointer-events:none;z-index:0;background-image:linear-gradient(rgba(150,140,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(150,140,255,.04) 1px,transparent 1px);background-size:46px 46px;background-attachment:fixed;" />
      <div style="position:absolute;inset:0;pointer-events:none;z-index:0;font-family:var(--gsv-font-mono);">
        <span style="position:absolute;left:18%;top:14%;font-size:13px;color:#b6b1ff;opacity:.16;">✦</span>
        <span style="position:absolute;left:64%;top:9%;font-size:15px;color:#cdd5e6;opacity:.18;">∗</span>
        <span style="position:absolute;left:83%;top:33%;font-size:11px;color:#b6b1ff;opacity:.16;">·</span>
        <span style="position:absolute;left:43%;top:50%;font-size:10px;color:#cdd5e6;opacity:.2;">◦</span>
        <span style="position:absolute;left:23%;top:74%;font-size:12px;color:#b6b1ff;opacity:.14;">✦</span>
        <span style="position:absolute;left:72%;top:80%;font-size:13px;color:#cdd5e6;opacity:.16;">∗</span>
        <span style="position:absolute;left:91%;top:64%;font-size:9px;color:#cdd5e6;opacity:.22;">◦</span>
      </div>

      <div style={padStyle}>
        {/* ============ PANEL ============ */}
        {/* Navigation (back + breadcrumb) is owned by the shell ConsoleHeader. */}
        <div style={panelStyle}>
          {/* ===== FOLDER TAB BAR ===== */}
          <Tabs
            tabs={tabOrder.map((label) => label.toUpperCase())}
            value={activeIdx}
            onChange={(index) => setTab(tabOrder[index] || "general")}
            width={W}
            sticky
          />

          {/* ===== CONTENT ===== */}
          <div style="flex:1;min-width:0;position:relative;">
            {/* ---------- GENERAL ---------- */}
            {tab === "general" ? (
              <div style={genWrapStyle}>
                {/* left form column */}
                <div style="flex:1;min-width:0;max-width:640px;display:flex;flex-direction:column;">
                  {/* NAME */}
                  <div style="margin-bottom:24px;">
                    <TextInput
                      key={`ti-name-${formNonce}`}
                      value={name}
                      onChange={identityReadOnly ? undefined : setName}
                      placeholder="Name your agent"
                      size="large"
                      label="NAME"
                      readonly={identityReadOnly}
                    />
                  </div>

                  {/* ROLE */}
                  <div style="margin-bottom:24px;">
                    <TextInput
                      key={`ti-role-${formNonce}`}
                      value={role}
                      onChange={identityReadOnly ? undefined : setRole}
                      placeholder="e.g. PERSONAL AGENT"
                      size="medium"
                      label="ROLE"
                      readonly={identityReadOnly}
                    />
                  </div>

                  {/* DESCRIPTION */}
                  <div style="margin-bottom:28px;">
                    <TextArea
                      key={`ta-desc-${formNonce}`}
                      value={desc}
                      onChange={identityReadOnly ? undefined : setDesc}
                      placeholder="What is this agent for? A line or two."
                      rows={3}
                      size="medium"
                      label="DESCRIPTION"
                      readonly={identityReadOnly}
                    />
                  </div>

                  {/* MODEL */}
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <span style="font-size:9.5px;letter-spacing:.22em;color:var(--label);">MODEL</span>
                    {model === 0 ? (
                      <span style="font-size:9.5px;letter-spacing:.08em;color:var(--live);">
                        (<span style="border-bottom:1px solid var(--live);">AI DEFAULT</span>)
                      </span>
                    ) : null}
                  </div>
                  <div style="max-width:420px;margin-bottom:30px;">
                    <Select
                      key={`sel-model-${formNonce}`}
                      options={modelOptions}
                      value={model}
                      onChange={behaviorReadOnly ? undefined : setModel}
                      width={420}
                      disabled={behaviorReadOnly}
                    />
                  </div>

                  {/* TOOL PERMISSIONS */}
                  <Segmented
                    key={`seg-perm-${formNonce}`}
                    l0="ALLOW"
                    l1="ASK"
                    l2="DENY"
                    value={permVal}
                    onChange={behaviorReadOnly ? undefined : (i) => setPerm(PERMS[i] || "ask")}
                    width={segWidth}
                    label="TOOL PERMISSIONS"
                    disabled={behaviorReadOnly}
                  />

                  {/* GENERAL actions */}
                  <div style="display:flex;align-items:center;gap:12px;margin-top:42px;">
                    {identityReadOnly && behaviorReadOnly ? (
                      <span class="gsv-ae-readonly-note">READ ONLY</span>
                    ) : formError ? (
                      <span style="font-size:10px;letter-spacing:.12em;color:var(--error);">{formError}</span>
                    ) : flash ? (
                      <span style="font-size:10px;letter-spacing:.14em;color:var(--online);">{flash}</span>
                    ) : null}
                    <span style="flex:1;" />
                    {isNew ? (
                      <Button
                        variant="primary"
                        label={pendingAction === "create" ? "CREATING" : "CREATE AGENT"}
                        onClick={onCreate}
                        disabled={(identityReadOnly && behaviorReadOnly) || pendingAction !== null}
                      />
                    ) : (
                      <div style="display:flex;gap:12px;">
                        <Button variant="secondary" label="RESET" onClick={onResetGeneral} disabled={(identityReadOnly && behaviorReadOnly) || pendingAction !== null} />
                        <Button
                          variant="primary"
                          label={pendingAction === "save" ? "SAVING" : "SAVE"}
                          onClick={onSave}
                          disabled={(identityReadOnly && behaviorReadOnly) || pendingAction !== null}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* right identity column */}
                <div style={identityStyle}>
                  <Avatar src={imgSrc} status={status} size={58} cover={avatarCover} />
                  <div style="text-align:right;">
                    <div style="font-size:11px;letter-spacing:.18em;color:#7d78b8;">{meta.metaLabel}</div>
                    <div style="font-size:13px;letter-spacing:.1em;color:#cdd5e6;margin-top:6px;">{meta.created}</div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* ---------- FILES ---------- */}
            {tab === "files" ? (
              <div style={secPad}>
                {/* identity strip */}
                <div style="display:flex;flex-direction:column;gap:18px;margin-bottom:26px;">
                  <div style="display:flex;align-items:center;gap:16px;">
                    <Avatar src={imgSrc} status={status} size={52} cover={avatarCover} />
                    <div>
                      <div style="font-size:11px;letter-spacing:.18em;color:#7d78b8;">{meta.metaLabel}</div>
                      <div style="font-size:13px;letter-spacing:.1em;color:#cdd5e6;margin-top:6px;">{meta.created}</div>
                    </div>
                  </div>
                  <div>
                    <div style="font-family:var(--gsv-font-mono);font-weight:700;font-size:22px;letter-spacing:.04em;color:var(--text-hi);text-shadow:0 0 8px rgba(150,140,255,.4);">
                      {nameDisplay}
                    </div>
                    <div style="font-size:11px;letter-spacing:.16em;color:#a8a2dc;margin-top:8px;">{roleDisplay}</div>
                  </div>
                </div>

                {/* file folder tabs */}
                <div style="display:flex;align-items:flex-start;gap:30px;flex-wrap:wrap;padding-bottom:24px;border-bottom:1px solid var(--rule-inner);margin-bottom:22px;">
                  {files.map((f, i) => (
                    <button
                      type="button"
                      class="gsv-ae-file-tab"
                      onClick={() => {
                        setFileIdx(i);
                        setFlash("");
                        setFormError("");
                      }}
                    >
                      <svg width="34" height="30" viewBox="0 0 16 14" shape-rendering="crispEdges" fill={i === fileIdx ? "var(--accent-bright)" : "#4a4585"}>
                        <rect x="1" y="2" width="6" height="2" />
                        <rect x="1" y="4" width="14" height="9" />
                      </svg>
                      <span style={`font-size:10px;letter-spacing:.1em;color:${i === fileIdx ? "var(--text)" : "#9a95cf"};line-height:1.35;`}>
                        {f.label}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={filesReadOnly}
                    onClick={filesReadOnly ? undefined : onAddFile}
                    class={`gsv-ae-file-tab gsv-ae-newfile${filesReadOnly ? " is-disabled" : ""}`}
                  >
                    <svg width="34" height="30" viewBox="0 0 16 14" shape-rendering="crispEdges" fill="none" stroke="var(--dashed)" stroke-width="1">
                      <path d="M1.5 3.5 H6.5 V4.5" />
                      <rect x="1.5" y="4.5" width="13" height="8" />
                    </svg>
                    <span style="font-size:10px;letter-spacing:.1em;color:var(--accent);border-bottom:1px solid var(--accent);padding-bottom:1px;">NEW FILE</span>
                  </button>
                </div>

                {/* current file label */}
                <div style="font-size:10px;letter-spacing:.2em;color:var(--label);margin-bottom:11px;">{curFile.label}</div>

                {/* editor */}
                <textarea
                  class="gsv-ed gsv-ae-editor"
                  value={curFile.content}
                  onInput={onContent}
                  spellcheck={false}
                  readOnly={filesReadOnly}
                />

                {/* actions */}
                <div style="display:flex;align-items:center;gap:12px;margin-top:16px;">
                  <Button variant="dangerGhost" label="DELETE" onClick={onDelete} disabled={filesReadOnly} />
                  <span style="flex:1;" />
                  {filesReadOnly ? (
                    <span class="gsv-ae-readonly-note">READ ONLY</span>
                  ) : formError ? (
                    <span style="font-size:10px;letter-spacing:.12em;color:var(--error);">{formError}</span>
                  ) : pendingAction === "save" ? (
                    <span style="font-size:10px;letter-spacing:.14em;color:var(--accent);">SAVING</span>
                  ) : flash ? (
                    <span style="font-size:10px;letter-spacing:.14em;color:var(--online);">{flash}</span>
                  ) : null}
                  <Button variant="secondary" label="RESET" onClick={onReset} disabled={filesReadOnly || pendingAction !== null} />
                  <Button variant="primary" label="SAVE" onClick={onSave} disabled={filesReadOnly || pendingAction !== null} />
                </div>
              </div>
            ) : null}

            {/* ---------- TASKS ---------- */}
            {tab === "tasks" ? (
              <div style={secPad}>
                <div style="font-size:10px;letter-spacing:.2em;color:var(--label);margin-bottom:18px;">
                  TASKS ({TASKS.length})
                </div>
                <div style="border:1px solid var(--border);background:var(--panel-2);">
                  {TASKS.map((t, i) => (
                    <div style={`display:flex;align-items:center;gap:12px;padding:14px 16px;${i < TASKS.length - 1 ? "border-bottom:1px solid var(--rule-inner);" : ""}`}>
                      <span style={`width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:${dotColorFor(t.status)};${t.status !== "idle" ? `box-shadow:0 0 7px ${dotColorFor(t.status)};` : ""}`} />
                      <span style="font-size:12px;letter-spacing:.03em;color:var(--text);flex:1;min-width:0;">{t.name}</span>
                      <span style={`font-size:9px;letter-spacing:.14em;color:${colFor(t.status)};`}>{t.status.toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* DELETE CONFIRM MODAL */}
            {deleteOpen ? (
              <div class="gsv-ae-modal-scrim" onClick={onCancelDelete}>
                <div class="gsv-ae-modal-wrap" onClick={(event) => event.stopPropagation()}>
                  <ConfirmModal
                    title="CONFIRM DELETE"
                    message={`Are you sure you want to delete "${delName}"?`}
                    note="This file is removed from the agent -- it can't be recovered."
                    onCancel={onCancelDelete}
                    onConfirm={onConfirmDelete}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
