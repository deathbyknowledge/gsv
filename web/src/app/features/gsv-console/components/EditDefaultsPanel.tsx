import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { Select } from "../../../components/ui/Select";
import {
  FALLBACK_SETTING_INFO,
  MODEL_SETTING_INFO,
  REASONING_SETTING_INFO,
  REASONING_VALUES,
  reasoningIndexForValue,
  reasoningOptions,
} from "../../../components/ui/AgentEditor";
import { AgentToolsPanel } from "../../../components/ui/AgentToolsPanel";
import type { AgentToolTarget } from "../../../components/ui/agentToolApprovalOptions";
import {
  ContextSectionsEditor,
  type ContextSection,
} from "../../../components/ui/ContextSectionsEditor";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import { modelOptionsForConfig, type ConsoleModelOption } from "../domain/consoleAi";
import {
  approvalForAgentSave,
  behaviorForAccount,
  fallbackModelOptionsForAccount,
  inheritedFallbackModelLabelForAccount,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  modelOptionsForAccount,
  parseApprovalPolicy,
  serializeApprovalPolicy,
  type ApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import type { ConsoleAccount, ConsoleConfigEntry } from "../domain/consoleModels";
import { useConsoleAgentContext, useSaveConsoleAgentBehavior, useSaveConsoleAgentContext } from "../hooks/useConsoleData";
import { PromptReviewPanel } from "./PromptReviewPanel";
import "./EditDefaultsPanel.css";

export type EditDefaultsSection = "defaults" | "permissions" | "context" | "prompt";

/** Per-section surface copy. Each CREW default now opens its own titled
 *  surface (model defaults / permissions / global instructions). */
const SECTION_TITLE = {
  defaults: "MODEL DEFAULTS",
  permissions: "DEFAULT PERMISSIONS",
  context: "GLOBAL INSTRUCTIONS",
  prompt: "PROMPT REVIEW",
} satisfies Record<EditDefaultsSection, string>;

const SECTION_DESC = {
  defaults: "These are your preferences, applied to all your agents.",
  permissions:
    "When there are no overrides configured, all your agents will follow the default permission when using any tool. Overrides are machine or tool specific rules that take priority over the default action.",
  context: "Instructions all your agents follow. These do not take precedence over agent definitions.",
  prompt: "Inspect the exact next-run prompt, its source blocks, and their contribution to the final context.",
} satisfies Record<EditDefaultsSection, string>;

/** Draft seed from the loaded context files (mirrors editorFilesForAccount). */
function contextSectionsFromFiles(files: readonly { label: string; name: string; content: string; orig: string }[]): ContextSection[] {
  return files.map((file) => ({ ...file, origName: file.name }));
}

/** Signature for dirty-detection — only the fields a save persists. */
function contextSignature(files: readonly ContextSection[]): string {
  return JSON.stringify(files.map((file) => ({ label: file.label, name: file.name ?? "", content: file.content })));
}

export interface EditDefaultsPanelProps {
  /** Which surface to reveal on open — model defaults, permissions, or the
   *  context/files editor. Each is its own titled surface. */
  section?: EditDefaultsSection;
  onClose: () => void;
  /** The account whose defaults are edited (the viewer for CREW). */
  viewer: ConsoleAccount;
  config: readonly ConsoleConfigEntry[];
  targets: readonly AgentToolTarget[];
}

function modelIndexForValue(options: readonly ConsoleModelOption[], value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }
  const index = options.findIndex((option) => option.value.trim() === trimmed);
  return index >= 0 ? index : 0;
}

function optionsKey(options: readonly ConsoleModelOption[]): string {
  return options.map((option) => `${option.value}:${option.label}`).join(" ");
}

/** EditDefaultsPanel — the in-body editing surface behind the CREW "DEFAULTS"
 *  card, rendered in the list column with an ✕ back to the roster. The form is
 *  the create-agent behavior template verbatim (same field widths, spacings,
 *  info tips, shared AgentToolsPanel, AgentEditor-style actions row) minus the
 *  identity fields. One draft, one SAVE — through the agent editor's
 *  inheritance-preserving path. */
export function EditDefaultsPanel({
  section = "defaults",
  onClose,
  viewer,
  config,
  targets,
}: EditDefaultsPanelProps) {
  const saveBehavior = useSaveConsoleAgentBehavior();
  const saveContext = useSaveConsoleAgentContext();
  const context = useConsoleAgentContext(viewer.username);
  const contextEditable = !context.resource.isLoading
    && !context.resource.isUnavailable
    && !context.resource.isError;

  const behavior = behaviorForAccount(config, viewer.uid, viewer.uid);
  const savedPolicy = useMemo(() => parseApprovalPolicy(behavior.approval), [behavior.approval]);
  const savedSignature = serializeApprovalPolicy(savedPolicy);
  const modelSelectOptions = modelOptionsForAccount(
    modelOptionsForConfig(config),
    behavior.model,
    inheritedModelLabelForAccount(config, viewer.uid, viewer.uid),
  );
  const fallbackSelectOptions = fallbackModelOptionsForAccount(
    config,
    viewer.uid,
    viewer.uid,
    behavior.fallbackModel,
    inheritedFallbackModelLabelForAccount(config, viewer.uid, viewer.uid),
  );
  const reasoningSelectOptions = reasoningOptions(inheritedReasoningForAccount(config, viewer.uid, viewer.uid));

  const initialModelIndex = modelIndexForValue(modelSelectOptions, behavior.model);
  const initialFallbackIndex = modelIndexForValue(fallbackSelectOptions, behavior.fallbackModel);
  const initialReasoningIndex = reasoningIndexForValue(behavior.reasoning);
  const baselineFiles = contextSectionsFromFiles(context.files);
  const baselineFilesSignature = contextSignature(baselineFiles);
  // Behavior-only baseline — deliberately excludes the context query so a
  // behavior save (which invalidates the config query) can't re-baseline the
  // context draft out from under a still-unsaved / failed context edit.
  const behaviorBaselineKey = [
    initialModelIndex,
    initialFallbackIndex,
    initialReasoningIndex,
    savedSignature,
    optionsKey(modelSelectOptions),
    optionsKey(fallbackSelectOptions),
  ].join("|");

  const [modelIndex, setModelIndex] = useState(initialModelIndex);
  const [fallbackIndex, setFallbackIndex] = useState(initialFallbackIndex);
  const [reasoningIndex, setReasoningIndex] = useState(initialReasoningIndex);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(savedPolicy);
  const [filesDraft, setFilesDraft] = useState<ContextSection[]>(baselineFiles);
  const [contextIndex, setContextIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState("");
  const [formError, setFormError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const flashTimerRef = useRef<number | null>(null);
  // Set when an immediate delete has already reconciled the draft optimistically
  // (dropping the deleted file, keeping every other unsaved edit). Skips the one
  // context re-baseline that delete's own refetch triggers so those edits aren't
  // clobbered. Reset on a failed delete so a genuine refetch still re-baselines.
  const skipContextRebaselineRef = useRef(false);

  // Re-baseline behavior fields when the saved behavior changes (external edit,
  // or our own save round-tripping through the config query). `pending` is owned
  // solely by save()'s try/finally — this effect must not clear it, or a
  // behavior save that lands mid-combined-save (before the awaited context
  // write) would re-enable the controls while that write is still in flight.
  useEffect(() => {
    setModelIndex(initialModelIndex);
    setFallbackIndex(initialFallbackIndex);
    setReasoningIndex(initialReasoningIndex);
    setApprovalPolicy(savedPolicy);
    setConfirmDiscard(false);
  }, [behaviorBaselineKey]);

  // Re-baseline the context draft only when the saved context itself changes —
  // keyed off the context query alone so a behavior save (or failed partial
  // save) leaves an unsaved context draft intact. Skipped once after an
  // immediate delete, which has already reconciled the draft (see deleteSection).
  useEffect(() => {
    if (skipContextRebaselineRef.current) {
      skipContextRebaselineRef.current = false;
      return;
    }
    setFilesDraft(contextSectionsFromFiles(context.files));
    setContextIndex(0);
  }, [context.dataUpdatedAt]);

  // On open: move focus to the surface (in-place swap).
  useEffect(() => {
    rootRef.current?.focus();
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  // Each section ("defaults" / "permissions" / "context") is its own surface.
  // Switching sections doesn't remount, so unsaved drafts survive — scroll the
  // surface back to the top on switch.
  const isContext = section === "context";
  const isPermissions = section === "permissions";
  const isPrompt = section === "prompt";
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, [section]);

  const draftPolicySignature = serializeApprovalPolicy(approvalPolicy);
  const behaviorDirty =
    modelIndex !== initialModelIndex ||
    fallbackIndex !== initialFallbackIndex ||
    reasoningIndex !== initialReasoningIndex ||
    draftPolicySignature !== savedSignature;
  const contextDirty = contextEditable && contextSignature(filesDraft) !== baselineFilesSignature;
  const dirty = behaviorDirty || contextDirty;
  useUnsavedGuard(() => dirty);
  const requestGuardedLeave = useUnsavedGuardLeave();

  const editable = viewer.runnable;
  const disabled = !editable || pending;

  const touch = () => {
    setFlash("");
    setFormError("");
    setConfirmDiscard(false);
  };

  const resetDrafts = () => {
    setModelIndex(initialModelIndex);
    setFallbackIndex(initialFallbackIndex);
    setReasoningIndex(initialReasoningIndex);
    setApprovalPolicy(savedPolicy);
    setFilesDraft(contextSectionsFromFiles(context.files));
    setContextIndex(0);
    touch();
  };

  const save = async () => {
    if (!dirty || pending) {
      return;
    }
    setPending(true);
    setFlash("");
    setFormError("");
    try {
      if (behaviorDirty) {
        await saveBehavior.mutateAsync({
          uid: viewer.uid,
          model: modelIndex === 0 ? "" : modelSelectOptions[modelIndex]?.value ?? "",
          fallbackModel: fallbackIndex === 0 ? "" : fallbackSelectOptions[fallbackIndex]?.value ?? "",
          reasoning: reasoningIndex === 0 ? "" : REASONING_VALUES[reasoningIndex] ?? "",
          approval: approvalForAgentSave(draftPolicySignature, behavior),
        });
      }
      if (contextDirty) {
        await saveContext.mutateAsync({
          username: viewer.username,
          files: filesDraft,
          baseNames: context.files.map((file) => file.name),
        });
      }
      setFlash("✓ SAVED");
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = window.setTimeout(() => setFlash(""), 1800);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  // DELETE on the context surface commits immediately (per product decision):
  // persist the file removal to disk on confirm rather than staging it for the
  // next SAVE. Passes the saved baseline (minus the target) so ONLY the delete
  // runs — other unsaved section edits are left untouched, not written. A
  // brand-new section that was never saved just drops from the draft.
  const deleteSection = async (index: number) => {
    if (!editable || pending) {
      return;
    }
    const target = filesDraft[index];
    if (!target) {
      return;
    }
    const remaining = filesDraft.filter((_, candidate) => candidate !== index);
    const nextIndex = Math.max(0, Math.min(index, remaining.length - 1));
    const diskName = target.origName ?? target.name;
    const onDisk = Boolean(diskName) && context.files.some((file) => file.name === diskName);

    const prevDraft = filesDraft;
    const prevIndex = contextIndex;
    touch();
    setFilesDraft(remaining);
    setContextIndex(nextIndex);

    if (!onDisk) {
      return;
    }

    setPending(true);
    setFormError("");
    // The draft above is already the post-delete state (deleted file dropped,
    // every other unsaved edit kept); suppress the re-baseline that this delete's
    // own refetch will fire so it doesn't overwrite those edits with the server
    // baseline. Cleared on failure so a real refetch still re-baselines.
    skipContextRebaselineRef.current = true;
    try {
      await saveContext.mutateAsync({
        username: viewer.username,
        files: context.files.filter((file) => file.name !== diskName),
        baseNames: context.files.map((file) => file.name),
      });
    } catch (error) {
      // Persist failed — restore the section so the UI matches disk.
      skipContextRebaselineRef.current = false;
      setFilesDraft(prevDraft);
      setContextIndex(prevIndex);
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  const requestClose = () => {
    if (pending) {
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    requestGuardedLeave(onClose);
  };

  const discardAndClose = () => {
    resetDrafts();
    onClose();
  };

  // Shared action-row pieces. In the context surface these ride in the
  // ContextSectionsEditor `actions` slot (aligned with its DELETE); in the
  // behavior surface they sit in the panel's own footer row.
  const statusNode = !editable ? (
    <span class="gsv-sublabel" style="letter-spacing:.12em;">READ ONLY</span>
  ) : formError ? (
    <span class="gsv-sublabel" style="letter-spacing:.12em;color:var(--error);">{formError}</span>
  ) : flash ? (
    <span class="gsv-sublabel" style="letter-spacing:.14em;color:var(--online);">{flash}</span>
  ) : null;

  const actionButtons = (
    <>
      <Button variant="secondary" label="RESET" onClick={resetDrafts} disabled={!dirty || pending} />
      <Button
        variant="primary"
        label={pending ? "SAVING" : "SAVE"}
        onClick={() => void save()}
        disabled={!editable || !dirty || pending}
      />
    </>
  );

  return (
    <section class="gsv-edit-defaults" aria-label={SECTION_TITLE[section]} ref={rootRef} tabIndex={-1}>
      <div class="gsv-edit-defaults-head">
        <button
          type="button"
          class="gsv-edit-defaults-back gsv-sublabel"
          onClick={requestClose}
        >
          <span aria-hidden="true">←</span> AGENTS
        </button>
        <IconButton glyph="close" size="small" ariaLabel="Close editor" onClick={requestClose} />
      </div>

      <h3 class="gsv-edit-defaults-title gsv-section">
        {SECTION_TITLE[section]}
      </h3>

      <p class="gsv-edit-defaults-desc gsv-paragraph-small">
        {SECTION_DESC[section]}
      </p>

      {isPrompt ? (
        <PromptReviewPanel />
      ) : isContext ? (
        <ContextSectionsEditor
          files={filesDraft}
          onChange={(next) => {
            touch();
            setFilesDraft(next);
          }}
          activeIndex={contextIndex}
          onActiveIndexChange={(index) => {
            touch();
            setContextIndex(index);
          }}
          readOnly={!editable || !contextEditable || pending}
          onDeleteSection={(index) => void deleteSection(index)}
          actions={confirmDiscard ? undefined : (
            <>
              {statusNode}
              {actionButtons}
            </>
          )}
        />
      ) : isPermissions ? (
        <div class="gsv-edit-defaults-tools">
          <AgentToolsPanel
            policy={approvalPolicy}
            targets={[...targets]}
            disabled={disabled}
            hideHeading
            onChange={(next) => {
              touch();
              setApprovalPolicy(next);
            }}
          />
        </div>
      ) : (
        <>
          {/* Behavior fields — the create-agent form template verbatim
              (AgentEditor GENERAL column: 420/300 widths, 30px rhythm, info tips). */}
          <div style="max-width:420px;margin-bottom:30px;">
            <Select
              label="MODEL"
              info={MODEL_SETTING_INFO}
              requirement="optional"
              options={modelSelectOptions}
              value={modelIndex}
              onChange={disabled ? undefined : (index) => {
                touch();
                setModelIndex(index);
              }}
              width={420}
              disabled={disabled}
            />
          </div>

          <div style="max-width:420px;margin-bottom:30px;">
            <Select
              label="FALLBACK"
              info={FALLBACK_SETTING_INFO}
              requirement="optional"
              options={fallbackSelectOptions}
              value={fallbackIndex}
              onChange={disabled ? undefined : (index) => {
                touch();
                setFallbackIndex(index);
              }}
              width={420}
              disabled={disabled}
            />
          </div>

          <div style="max-width:300px;margin-bottom:30px;">
            <Select
              label="REASONING"
              info={REASONING_SETTING_INFO}
              requirement="optional"
              options={reasoningSelectOptions}
              value={reasoningIndex}
              onChange={disabled ? undefined : (index) => {
                touch();
                setReasoningIndex(index);
              }}
              width={300}
              disabled={disabled}
            />
          </div>
        </>
      )}

      {confirmDiscard ? (
        <div
          class="gsv-edit-defaults-discard"
          role="alertdialog"
          aria-label="Discard changes?"
          style="margin-top:42px;"
        >
          <span class="gsv-sublabel">Discard unsaved default changes?</span>
          <div style="display:flex;gap:12px;">
            <Button variant="danger" label="DISCARD" onClick={discardAndClose} />
            <Button variant="secondary" label="KEEP EDITING" onClick={() => setConfirmDiscard(false)} />
          </div>
        </div>
      ) : isContext || isPrompt ? null : (
        <div style="display:flex;align-items:center;gap:12px;margin-top:42px;">
          {statusNode}
          <span style="flex:1;" />
          <div style="display:flex;gap:12px;">{actionButtons}</div>
        </div>
      )}
    </section>
  );
}
