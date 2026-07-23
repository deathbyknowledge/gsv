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
import { useUnsavedGuard } from "../../gsv-shell/unsaved/unsavedGuard";
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
import "./EditDefaultsPanel.css";

export type EditDefaultsSection = "defaults" | "overrides" | "context";

/** Draft seed from the loaded context files (mirrors editorFilesForAccount). */
function contextSectionsFromFiles(files: readonly { label: string; name: string; content: string; orig: string }[]): ContextSection[] {
  return files.map((file) => ({ ...file, origName: file.name }));
}

/** Signature for dirty-detection — only the fields a save persists. */
function contextSignature(files: readonly ContextSection[]): string {
  return JSON.stringify(files.map((file) => ({ label: file.label, name: file.name ?? "", content: file.content })));
}

export interface EditDefaultsPanelProps {
  /** Which part to reveal on open — "overrides" scrolls the overrides section
   *  into view (both CTAs share this one surface). */
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
  const baselineKey = [
    initialModelIndex,
    initialFallbackIndex,
    initialReasoningIndex,
    savedSignature,
    context.dataUpdatedAt,
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
  const overridesRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Re-baseline whenever the saved values change (external edit, or our own
  // save round-tripping through the config / context queries).
  useEffect(() => {
    setModelIndex(initialModelIndex);
    setFallbackIndex(initialFallbackIndex);
    setReasoningIndex(initialReasoningIndex);
    setApprovalPolicy(savedPolicy);
    setFilesDraft(contextSectionsFromFiles(context.files));
    setContextIndex(0);
    setConfirmDiscard(false);
    setPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineKey]);

  // On open: move focus to the surface (in-place swap).
  useEffect(() => {
    rootRef.current?.focus();
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  // "context" is its own surface; "defaults"/"overrides" share the behavior
  // form (overrides scrolls to the tools panel). Switching sections doesn't
  // remount, so unsaved drafts survive.
  const isContext = section === "context";
  useEffect(() => {
    if (section === "overrides") {
      overridesRef.current?.scrollIntoView({ block: "start" });
    } else {
      rootRef.current?.scrollIntoView({ block: "start" });
    }
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

  const requestClose = () => {
    if (pending) {
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
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
    <section class="gsv-edit-defaults" aria-label="Edit defaults" ref={rootRef} tabIndex={-1}>
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
        {isContext ? "GLOBAL INSTRUCTIONS" : "EDIT DEFAULTS"}
      </h3>

      <p class="gsv-edit-defaults-desc gsv-paragraph-small">
        {isContext
          ? "Instructions all your agents follow. These do not take precedence over agent definitions."
          : "These are your preferences, applied to all your agents."}
      </p>

      {isContext ? (
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
          actions={confirmDiscard ? undefined : (
            <>
              {statusNode}
              {actionButtons}
            </>
          )}
        />
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

          <div ref={overridesRef} class="gsv-edit-defaults-tools">
            <AgentToolsPanel
              policy={approvalPolicy}
              targets={[...targets]}
              disabled={disabled}
              defaultDescription="When there are no overrides configured, all your agents will follow the default permission when using any tool. Overrides are machine or tool specific rules that take priority over the default action."
              onChange={(next) => {
                touch();
                setApprovalPolicy(next);
              }}
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
      ) : isContext ? null : (
        <div style="display:flex;align-items:center;gap:12px;margin-top:42px;">
          {statusNode}
          <span style="flex:1;" />
          <div style="display:flex;gap:12px;">{actionButtons}</div>
        </div>
      )}
    </section>
  );
}
