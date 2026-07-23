import { useEffect, useRef, useState } from "preact/hooks";
import "./AgentEditor.css";
import { TextInput } from "./TextInput";
import { TextArea } from "./TextArea";
import { Select, type SelectOption } from "./Select";
import { Button } from "./Button";
import { Avatar, type AvatarStatus } from "./Avatar";
import { Tabs } from "./Tabs";
import { SectionHeader } from "./SectionHeader";
import { ContextSectionsEditor } from "./ContextSectionsEditor";
import { approvalTargetFromValue } from "../../domain/agentApproval";
import {
  AgentToolsPanel,
  type AgentToolApprovalAction,
  type AgentToolApprovalPolicy,
  type AgentToolApprovalRule,
  type AgentToolTarget,
} from "./AgentToolsPanel";
import { useUnsavedGuard } from "../../features/gsv-shell/unsaved/unsavedGuard";

export type AgentEditorMode = "new" | "manage";
export type AgentEditorTab = "general" | "files" | "tasks";
export type AgentEditorModelOption = SelectOption;

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
  models?: AgentEditorModelOption[];
  initialModel?: string;
  fallbackModels?: AgentEditorModelOption[];
  initialFallbackModel?: string;
  initialReasoning?: string;
  inheritedReasoning?: string;
  initialPermission?: string;
  initialApprovalPolicy?: string;
  approvalPolicySourceLabel?: string;
  capabilities?: string[];
  toolTargets?: AgentToolTarget[];
  files?: AgentEditorFile[];
  tasks?: AgentEditorTask[];
  readOnly?: boolean;
  generalReadOnly?: boolean;
  identityReadOnly?: boolean;
  behaviorReadOnly?: boolean;
  filesReadOnly?: boolean;
  initialTab?: AgentEditorTab;
  onTabChange?: (tab: AgentEditorTab) => void;
  onCreate?: (draft: AgentEditorDraft) => Promise<void> | void;
  onSave?: (draft: AgentEditorDraft) => Promise<void> | void;
}

type TaskStatus = "running" | "error" | "idle" | "online";

export interface AgentEditorFile {
  label: string;
  name?: string;
  origName?: string;
  content: string;
  orig?: string;
}

export interface AgentEditorDraft {
  name: string;
  role: string;
  description: string;
  model: string;
  modelIndex: number;
  fallbackModel: string;
  fallbackModelIndex: number;
  reasoning: string;
  reasoningIndex: number;
  permission: string;
  approvalPolicy: string;
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
  fallbackModel: number;
  reasoning: number;
  approvalPolicy: AgentToolApprovalPolicy;
  approvalPolicyRaw: string;
  files: AgentEditorFile[];
  tasks: AgentEditorTask[];
}

const MODELS: AgentEditorModelOption[] = [
  { label: "INHERIT DEFAULT", value: "" },
  { label: "GATEWAY DEFAULT", value: "GATEWAY DEFAULT" },
  { label: "FAST MODEL", value: "FAST MODEL" },
  { label: "DEEP MODEL", value: "DEEP MODEL" },
];
const FALLBACK_MODELS: AgentEditorModelOption[] = [
  { label: "INHERIT FALLBACK", value: "" },
];
export const REASONING_VALUES = ["", "off", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_APPROVAL_POLICY: AgentToolApprovalPolicy = {
  default: "auto",
  rules: [
    { match: "shell.exec", action: "ask" },
    { match: "net.fetch", action: "ask" },
    { match: "fs.delete", action: "ask" },
    { match: "sys.mcp.call", action: "ask" },
  ],
};
export const MODEL_SETTING_INFO = "Which AI this agent uses to respond. Inherit uses the default model.";
export const FALLBACK_SETTING_INFO = "Backup AI to try if the main one fails. Inherit uses the default backup, if one is set.";
export const REASONING_SETTING_INFO = "How much the AI thinks before replying. Higher can help with hard tasks, but may be slower.";

function optionValue(option: AgentEditorModelOption): string {
  return typeof option === "string" ? option : option.value ?? option.label;
}

function modelIndexForValue(value: string | undefined, options: readonly AgentEditorModelOption[] | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return 0;
  }
  const modelOptions = options && options.length > 0 ? options : MODELS;
  const index = modelOptions.findIndex((option) => optionValue(option).trim() === trimmed);
  return index >= 0 ? index : 0;
}

export function reasoningIndexForValue(value: string | undefined): number {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed || trimmed === "inherit") {
    return 0;
  }
  const index = REASONING_VALUES.indexOf(trimmed);
  return index >= 0 ? index : 0;
}

function reasoningOptionLabel(value: string): string {
  if (!value) return "Inherit default";
  if (value === "xhigh") return "Extra high";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function reasoningOptions(inherited: string | undefined): SelectOption[] {
  const inheritedLabel = inherited?.trim();
  return REASONING_VALUES.map((value) => value
    ? { label: reasoningOptionLabel(value), value }
    : {
        label: inheritedLabel ? `Inherit: ${reasoningOptionLabel(inheritedLabel)}` : "Inherit default",
        value: "",
      });
}

function tabTitle(tab: AgentEditorTab): string {
  return tab === "files" ? "CONTEXT" : tab.toUpperCase();
}

function permissionForValue(value: string | undefined): AgentToolApprovalAction {
  if (value === "allow") {
    return "auto";
  }
  return value === "auto" || value === "deny" || value === "ask" ? value : "ask";
}

function legacyApprovalTarget(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const target = (value as { target?: unknown }).target;
  return approvalTargetFromValue(target === "device" ? "targets/*" : target);
}

function parseApprovalPolicy(raw: string | undefined, fallbackAction: string | undefined): AgentToolApprovalPolicy {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return fallbackAction
      ? { default: permissionForValue(fallbackAction), rules: [] }
      : DEFAULT_APPROVAL_POLICY;
  }
  try {
    const parsed = JSON.parse(trimmed) as { default?: unknown; rules?: unknown };
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules
          .map((entry): AgentToolApprovalRule | null => {
            const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
            const match = typeof record.match === "string" ? record.match.trim() : "";
            if (!match) {
              return null;
            }
            const target = approvalTargetFromValue(record.target) ?? legacyApprovalTarget(record.when);
            return {
              match,
              ...(target ? { target } : {}),
              action: permissionForValue(String(record.action ?? "")),
            };
          })
          .filter((rule): rule is AgentToolApprovalRule => rule !== null)
      : [];
    return {
      default: parsed.default === undefined ? DEFAULT_APPROVAL_POLICY.default : permissionForValue(String(parsed.default ?? "")),
      rules: Array.isArray(parsed.rules) ? rules : DEFAULT_APPROVAL_POLICY.rules,
    };
  } catch {
    return fallbackAction
      ? { default: permissionForValue(fallbackAction), rules: [] }
      : DEFAULT_APPROVAL_POLICY;
  }
}

function serializeApprovalPolicy(policy: AgentToolApprovalPolicy): string {
  const rules = policy.rules
    .map((rule) => ({
      match: rule.match.trim(),
      ...(rule.target ? { target: rule.target } : {}),
      action: permissionForValue(rule.action),
    }))
    .filter((rule) => rule.match.length > 0);
  return JSON.stringify({ default: policy.default, rules });
}

function defaults(mode: AgentEditorMode, props: AgentEditorProps): Defaults {
  const files = props.files ?? null;
  const tasks = props.tasks ?? null;
  const approvalPolicy = parseApprovalPolicy(props.initialApprovalPolicy, props.initialPermission);

  if (mode === "manage") {
    return {
      name: props.initialName ?? "Primary Agent",
      role: props.initialRole ?? "PRIMARY AGENT",
      desc: props.initialDescription ?? "Primary GSV crew member. Manage identity, operating notes, model, and tool permissions here.",
      created: props.createdLabel ?? "ACTIVE",
      metaLabel: props.metaLabel ?? "CREATED:",
      status: props.status ?? "online",
      model: modelIndexForValue(props.initialModel, props.models),
      fallbackModel: modelIndexForValue(props.initialFallbackModel, props.fallbackModels ?? FALLBACK_MODELS),
      reasoning: reasoningIndexForValue(props.initialReasoning),
      approvalPolicy,
      approvalPolicyRaw: serializeApprovalPolicy(approvalPolicy),
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
    fallbackModel: modelIndexForValue(props.initialFallbackModel, props.fallbackModels ?? FALLBACK_MODELS),
    reasoning: reasoningIndexForValue(props.initialReasoning),
    approvalPolicy,
    approvalPolicyRaw: serializeApprovalPolicy(approvalPolicy),
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
 *  authoring surface with GENERAL / CONTEXT / TASKS folder tabs. GENERAL composes
 *  TextInput/TextArea/Select/Segmented/Button atoms; CONTEXT has a markdown
 *  editor + delete-confirm modal. */
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
  const fallbackModelOptions = props.fallbackModels && props.fallbackModels.length > 0
    ? props.fallbackModels
    : FALLBACK_MODELS;
  const reasonOptions = reasoningOptions(props.inheritedReasoning);

  const metaRef = useRef<Defaults>(defaults(mode, props));
  const meta = metaRef.current;

  const [tab, setTabState] = useState<AgentEditorTab>(props.initialTab ?? "general");
  const [fileIdx, setFileIdx] = useState(0);
  const [approvalPolicy, setApprovalPolicy] = useState<AgentToolApprovalPolicy>(meta.approvalPolicy);
  const [model, setModel] = useState(meta.model);
  const [fallbackModel, setFallbackModel] = useState(meta.fallbackModel);
  const [reasoning, setReasoning] = useState(meta.reasoning);
  const [name, setName] = useState(meta.name);
  const [role, setRole] = useState(meta.role);
  const [desc, setDesc] = useState(meta.desc);
  const [files, setFiles] = useState<AgentEditorFile[]>(meta.files.map((f) => ({ ...f, orig: f.orig ?? f.content })));
  const [flash, setFlash] = useState("");
  const [formError, setFormError] = useState("");
  const [pendingAction, setPendingAction] = useState<"create" | "save" | null>(null);
  const [w, setW] = useState(0);
  const [formNonce, setFormNonce] = useState(0);

  const flashTimer = useRef<number | undefined>(undefined);

  const setActiveTab = (next: AgentEditorTab) => {
    setTabState(next);
    props.onTabChange?.(next);
  };

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
  const tabOrder: AgentEditorTab[] =
    !isNew && (meta.tasks || []).length > 0 ? ["general", "files", "tasks"] : ["general", "files"];
  const activeIdx = Math.max(0, tabOrder.indexOf(tab));

  useEffect(() => {
    if (!tabOrder.includes(tab)) {
      setActiveTab("general");
    }
  }, [tab, tabOrder.join("|")]);

  // ---- avatar ----
  const imgSrc = avatarSrc ?? "img/agent-0.png";
  const status = meta.status;

  // ---- files ----
  const hasContextSections = files.length > 0;

  // ---- unsaved-changes guard ----
  // Baseline is the initial values captured once in metaRef (see line ~172).
  // Scalars compare against meta.*; files compare body vs per-file `orig`
  // baseline, plus a count check to catch added/removed files.
  const dirty =
    name !== meta.name ||
    role !== meta.role ||
    desc !== meta.desc ||
    model !== meta.model ||
    fallbackModel !== meta.fallbackModel ||
    reasoning !== meta.reasoning ||
    serializeApprovalPolicy(approvalPolicy) !== meta.approvalPolicyRaw ||
    files.length !== meta.files.length ||
    files.some(
      (f, i) => f.label !== meta.files[i]?.label || f.name !== meta.files[i]?.name || f.content !== (f.orig ?? f.content),
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

  // ---- handlers ----
  const onFilesChange = (next: AgentEditorFile[]) => {
    setFiles(next);
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
    model: optionValue(modelOptions[model] ?? ""),
    modelIndex: model,
    fallbackModel: optionValue(fallbackModelOptions[fallbackModel] ?? ""),
    fallbackModelIndex: fallbackModel,
    reasoning: REASONING_VALUES[reasoning] ?? "",
    reasoningIndex: reasoning,
    permission: approvalPolicy.default,
    approvalPolicy: serializeApprovalPolicy(approvalPolicy),
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
    setFallbackModel(meta.fallbackModel);
    setReasoning(meta.reasoning);
    setApprovalPolicy(meta.approvalPolicy);
    setFormNonce((n) => n + 1);
    setFormError("");
    setFlash("");
  };

  // ---- styles ----
  const padStyle = "position:relative;z-index:2;";
  const panelStyle =
    "position:relative;z-index:2;display:flex;flex-direction:column;min-height:" +
    (narrow ? "480px" : "560px") + ";";
  // Big-screen reading width: center tab content into the shared column while
  // the header/tab strips stay full-width. The gutter is 0 below the cap.
  const genWrapStyle = narrow
    ? "display:flex;flex-direction:column;padding:22px 16px 30px;gap:20px;padding-inline:max(16px,var(--gsv-gutter));"
    : "display:flex;flex-direction:column;padding:28px 32px 40px;gap:22px;padding-inline:max(32px,var(--gsv-gutter));";
  const identityStyle = "order:-1;display:flex;flex-direction:row;align-items:center;gap:16px;width:100%;";
  const secPad = narrow
    ? "padding:20px 16px 28px;padding-inline:max(16px,var(--gsv-gutter));"
    : "padding:28px 32px 36px;padding-inline:max(32px,var(--gsv-gutter));";

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
        {/* Navigation (back + breadcrumb) is owned by the shell ConsoleHeader.
            Same full-width header as the list/detail pages: name + status. */}
        <SectionHeader
          className="gsv-ae-header"
          title={nameDisplay}
          meta={status.toUpperCase()}
          divider
          headingLevel={2}
        />
        <div style={panelStyle}>
          {/* ===== FOLDER TAB BAR ===== */}
          <Tabs
            className="gsv-ae-tabs"
            tabs={tabOrder.map(tabTitle)}
            value={activeIdx}
            onChange={(index) => setActiveTab(tabOrder[index] || "general")}
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
                      requirement="required"
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
                      requirement="required"
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
                      requirement="optional"
                      readonly={identityReadOnly}
                    />
                  </div>

                  <div class="gsv-ae-overrides-heading" aria-hidden="true">
                    <span>OVERRIDES</span>
                  </div>

                  {/* MODEL */}
                  <div style="max-width:420px;margin-bottom:30px;">
                    <Select
                      key={`sel-model-${formNonce}`}
                      label="MODEL"
                      info={MODEL_SETTING_INFO}
                      requirement="optional"
                      options={modelOptions}
                      value={model}
                      onChange={behaviorReadOnly ? undefined : setModel}
                      width={420}
                      disabled={behaviorReadOnly}
                    />
                  </div>

                  {/* FALLBACK MODEL */}
                  <div style="max-width:420px;margin-bottom:30px;">
                    <Select
                      key={`sel-fallback-model-${formNonce}`}
                      label="FALLBACK"
                      info={FALLBACK_SETTING_INFO}
                      requirement="optional"
                      options={fallbackModelOptions}
                      value={fallbackModel}
                      onChange={behaviorReadOnly ? undefined : setFallbackModel}
                      width={420}
                      disabled={behaviorReadOnly}
                    />
                  </div>

                  {/* REASONING */}
                  <div style="max-width:300px;margin-bottom:30px;">
                    <Select
                      key={`sel-reasoning-${formNonce}`}
                      label="REASONING"
                      info={REASONING_SETTING_INFO}
                      requirement="optional"
                      options={reasonOptions}
                      value={reasoning}
                      onChange={behaviorReadOnly ? undefined : setReasoning}
                      width={300}
                      disabled={behaviorReadOnly}
                    />
                  </div>

                  <AgentToolsPanel
                    key={`tools-${formNonce}`}
                    policy={approvalPolicy}
                    sourceLabel={props.approvalPolicySourceLabel}
                    capabilities={props.capabilities}
                    targets={props.toolTargets}
                    disabled={behaviorReadOnly}
                    onChange={setApprovalPolicy}
                  />

                  {/* GENERAL actions */}
                  <div style="display:flex;align-items:center;gap:12px;margin-top:42px;">
                    {identityReadOnly && behaviorReadOnly ? (
                      <span class="gsv-ae-readonly-note gsv-sublabel">READ ONLY</span>
                    ) : formError ? (
                      <span class="gsv-sublabel" style="letter-spacing:.12em;color:var(--error);">{formError}</span>
                    ) : flash ? (
                      <span class="gsv-sublabel" style="letter-spacing:.14em;color:var(--online);">{flash}</span>
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
                    <div class="gsv-label" style="letter-spacing:.18em;color:#7d78b8;">{meta.metaLabel}</div>
                    <div class="gsv-paragraph-small" style="letter-spacing:.1em;color:#cdd5e6;margin-top:6px;">{meta.created}</div>
                  </div>
                </div>
              </div>
            ) : null}

            {/* ---------- CONTEXT ---------- */}
            {tab === "files" ? (
              <div style={secPad}>
                {/* identity strip */}
                <div style="display:flex;flex-direction:column;gap:18px;margin-bottom:26px;">
                  <div style="display:flex;align-items:center;gap:16px;">
                    <Avatar src={imgSrc} status={status} size={52} cover={avatarCover} />
                    <div>
                      <div class="gsv-label" style="letter-spacing:.18em;color:#7d78b8;">{meta.metaLabel}</div>
                      <div class="gsv-paragraph-small" style="letter-spacing:.1em;color:#cdd5e6;margin-top:6px;">{meta.created}</div>
                    </div>
                  </div>
                  <div>
                    <div class="gsv-title" style="letter-spacing:.04em;color:var(--text-hi);text-shadow:0 0 8px rgba(150,140,255,.4);">
                      {nameDisplay}
                    </div>
                    <div class="gsv-label" style="letter-spacing:.16em;color:#a8a2dc;margin-top:8px;">{roleDisplay}</div>
                  </div>
                </div>

                <ContextSectionsEditor
                  files={files}
                  onChange={onFilesChange}
                  activeIndex={fileIdx}
                  onActiveIndexChange={(index) => {
                    setFileIdx(index);
                    setFlash("");
                    setFormError("");
                  }}
                  readOnly={filesReadOnly}
                  actions={
                    <>
                      {filesReadOnly ? (
                        <span class="gsv-ae-readonly-note gsv-sublabel">READ ONLY</span>
                      ) : formError ? (
                        <span class="gsv-sublabel" style="letter-spacing:.12em;color:var(--error);">{formError}</span>
                      ) : pendingAction === "save" ? (
                        <span class="gsv-sublabel" style="letter-spacing:.14em;color:var(--accent);">SAVING</span>
                      ) : flash ? (
                        <span class="gsv-sublabel" style="letter-spacing:.14em;color:var(--online);">{flash}</span>
                      ) : null}
                      <Button variant="secondary" label="RESET" onClick={onReset} disabled={filesReadOnly || !hasContextSections || pendingAction !== null} />
                      <Button variant="primary" label="SAVE" onClick={onSave} disabled={filesReadOnly || pendingAction !== null} />
                    </>
                  }
                />
              </div>
            ) : null}

            {/* ---------- TASKS ---------- */}
            {tab === "tasks" ? (
              <div style={secPad}>
                <div class="gsv-sublabel" style="letter-spacing:.2em;color:var(--label);margin-bottom:18px;">
                  TASKS ({TASKS.length})
                </div>
                <div style="border:1px solid var(--border);background:var(--panel-2);">
                  {TASKS.map((t, i) => (
                    <div style={`display:flex;align-items:center;gap:12px;padding:14px 16px;${i < TASKS.length - 1 ? "border-bottom:1px solid var(--rule-inner);" : ""}`}>
                      <span style={`width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:${dotColorFor(t.status)};${t.status !== "idle" ? `box-shadow:0 0 7px ${dotColorFor(t.status)};` : ""}`} />
                      <span class="gsv-listitem" style="letter-spacing:.03em;color:var(--text);flex:1;min-width:0;">{t.name}</span>
                      <span class="gsv-sublabel" style={`letter-spacing:.14em;color:${colFor(t.status)};`}>{t.status.toUpperCase()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
