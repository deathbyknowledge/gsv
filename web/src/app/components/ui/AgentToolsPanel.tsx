import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { InfoTip } from "./InfoTip";
import { Segmented } from "./Segmented";
import { Select } from "./Select";
import { Tag } from "./Tag";
import {
  APPROVAL_ACTIONS,
  actionIndex,
  actionLabel,
  approvalOptionValue,
  defaultOverrideAction,
  humanToolCapabilityLabel,
  matchIndexForRule,
  matchOptionsForRule,
  targetIndexForRule,
  targetLabelForRule,
  targetOptionsForRule,
  type AgentToolApprovalAction,
  type AgentToolApprovalPolicy,
  type AgentToolApprovalRule,
  type AgentToolTarget,
} from "./agentToolApprovalOptions";
import "./AgentToolsPanel.css";

export type {
  AgentToolApprovalAction,
  AgentToolApprovalPolicy,
  AgentToolApprovalRule,
  AgentToolTarget,
} from "./agentToolApprovalOptions";
export { humanToolCapabilityLabel } from "./agentToolApprovalOptions";

export interface AgentToolsPanelProps {
  policy: AgentToolApprovalPolicy;
  sourceLabel?: string;
  capabilities?: readonly string[];
  targets?: readonly AgentToolTarget[];
  disabled?: boolean;
  /** Copy under the DEFAULT PERMISSIONS title. Defaults to single-agent wording;
   *  crew defaults / system overrides pass the "all your agents" framing. */
  defaultDescription?: string;
  onChange: (policy: AgentToolApprovalPolicy) => void;
}

const DEFAULT_PERMISSION_DESC = "Used when no approval override matches.";

const TOOL_APPROVAL_INFO = "Tools let agents take actions like reading files or running commands. Approvals decide what can happen automatically, what asks first, and what is blocked.";
const PRIORITY_INFO = "When several overrides match, the most machine-specific rule wins, then the most tool-specific. If still tied, rules higher in this list win.";
const MACHINE_INFO = "Where this override applies: every machine, the GSV computer, or one named machine.";
const ACTION_INFO = "What happens when the tool and machine match: allow it, ask for confirmation, or block it.";

function ruleSignature(policy: AgentToolApprovalPolicy): string {
  return JSON.stringify({ default: policy.default, rules: policy.rules });
}

/** AgentToolsPanel — controlled tool-approval editor shared by the agent
 *  editor / create-agent form, the global settings page, and the CREW defaults
 *  editor. Stored overrides render read-only until pencil-unlocked; ADD
 *  OVERRIDE pins one new editable rule on top (top tie-break priority — the
 *  gateway resolves ties first-in-list) and is guarded so only one unsaved new
 *  rule can exist at a time. Editing/new flags are internal UI state; they
 *  reset whenever the incoming policy changes from outside (host reset,
 *  remount baseline, post-save refresh). */
export function AgentToolsPanel({
  policy,
  sourceLabel,
  targets = [],
  disabled = false,
  defaultDescription = DEFAULT_PERMISSION_DESC,
  onChange,
}: AgentToolsPanelProps) {
  const normalizedSource = sourceLabel?.trim();
  const [editingIndexes, setEditingIndexes] = useState<ReadonlySet<number>>(new Set());
  const [newIndex, setNewIndex] = useState<number | null>(null);
  // Signature of the last policy WE emitted — an incoming policy that doesn't
  // match it is an external change (reset/baseline), so the row UI state resets.
  const emittedRef = useRef<string | null>(null);
  const signature = ruleSignature(policy);

  useEffect(() => {
    if (emittedRef.current === signature) {
      emittedRef.current = null;
      return;
    }
    emittedRef.current = null;
    setEditingIndexes(new Set());
    setNewIndex(null);
  }, [signature]);

  const emit = (next: AgentToolApprovalPolicy) => {
    emittedRef.current = ruleSignature(next);
    onChange(next);
  };

  const addRule = () => {
    // Open one fresh editable override pinned on top (top tie-priority). Any row
    // currently open (a prior new row, or a pencil-edited one) collapses to a
    // read-only summary — its values are already applied to the policy — so
    // several overrides can be staged in a single draft without a save between
    // each. Keeps exactly one row expanded at a time.
    setEditingIndexes(new Set());
    setNewIndex(0);
    emit({
      ...policy,
      rules: [{ match: "fs.*", action: defaultOverrideAction(policy.default) }, ...policy.rules],
    });
  };

  const removeRule = (index: number) => {
    setEditingIndexes((current) => new Set(
      [...current].filter((candidate) => candidate !== index).map((candidate) => candidate > index ? candidate - 1 : candidate),
    ));
    setNewIndex((current) => current === null || current === index
      ? null
      : current > index ? current - 1 : current);
    emit({
      ...policy,
      rules: policy.rules.filter((_, candidate) => candidate !== index),
    });
  };

  const startEditing = (index: number) => {
    setEditingIndexes((current) => new Set([...current, index]));
  };

  const updateRule = (index: number, next: AgentToolApprovalRule) => {
    emit({
      ...policy,
      rules: policy.rules.map((rule, candidate) => candidate === index ? next : rule),
    });
  };

  return (
    <section class="gsv-tools-panel" aria-label="Agent tools">
      <div class="gsv-tools-heading">
        <h4 class="gsv-tools-title gsv-section">DEFAULT PERMISSIONS</h4>
        <p class="gsv-tools-desc gsv-paragraph-small">{defaultDescription}</p>
      </div>

      <div class="gsv-tools-field">
        <div class="gsv-tools-field-lab">
          <span class="gsv-fld-lab-t gsv-sublabel">TOOL APPROVAL</span>
          <InfoTip text={TOOL_APPROVAL_INFO} position="right" label="Tool approval info" />
          {normalizedSource ? <Tag tone="info" label={normalizedSource.toUpperCase()} boxed /> : null}
        </div>
        <Segmented
          l0="ALLOW"
          l1="ASK"
          l2="BLOCK"
          value={actionIndex(policy.default)}
          onChange={disabled ? undefined : (index) => emit({ ...policy, default: APPROVAL_ACTIONS[index] ?? "ask" })}
          width={300}
          ariaLabel="Tool approval default"
          disabled={disabled}
        />
      </div>

      <div class="gsv-tools-field">
        <div class="gsv-tools-field-lab gsv-tools-overrides-lab">
          <span class="gsv-tools-overrides-name">
            <span class="gsv-fld-lab-t gsv-sublabel">OVERRIDES</span>
            <InfoTip text={PRIORITY_INFO} position="right" label="Override priority" />
          </span>
          <Button
            variant="link"
            label="ADD OVERRIDE"
            disabled={disabled}
            onClick={addRule}
          />
        </div>

        {policy.rules.length > 0 ? (
        <ul class="gsv-tools-rules" aria-label="Tool approval overrides">
          {policy.rules.map((rule, index) => {
            const toolLabel = humanToolCapabilityLabel(rule.match);
            const isNewRule = index === newIndex;
            const isEditing = isNewRule || editingIndexes.has(index);
            if (!isEditing) {
              return (
                <li class="gsv-tools-rule-item" key={index}>
                  <div class="gsv-tools-rule-summary">
                    <div class="gsv-tools-rule-text">
                      <span class="gsv-listitem">{toolLabel}</span>
                      <span class="gsv-sublabel">
                        {targetLabelForRule(rule.target, targets)} · {actionLabel(rule.action)}
                      </span>
                    </div>
                    <div class="gsv-tools-rule-buttons">
                      <IconButton
                        glyph="edit"
                        size="medium"
                        ariaLabel={`Edit override: ${toolLabel}`}
                        disabled={disabled}
                        onClick={() => startEditing(index)}
                      />
                      <IconButton
                        glyph="close"
                        size="medium"
                        ariaLabel={`Remove override: ${toolLabel}`}
                        disabled={disabled}
                        onClick={() => removeRule(index)}
                      />
                    </div>
                  </div>
                </li>
              );
            }
            const matchOptions = matchOptionsForRule(rule.match);
            const targetOptions = targetOptionsForRule(rule.target, targets);
            return (
              <li class="gsv-tools-rule-item is-editing" key={index}>
                <div class="gsv-tools-rule-edit">
                  <div class="gsv-tools-rule-edit-head">
                    <span class="gsv-sublabel">{isNewRule ? "NEW OVERRIDE" : "EDIT OVERRIDE"}</span>
                    {isNewRule ? <InfoTip text={PRIORITY_INFO} position="right" label="Override priority" /> : null}
                    <IconButton
                      glyph="close"
                      size="small"
                      ariaLabel={`Remove override: ${toolLabel}`}
                      disabled={disabled}
                      onClick={() => removeRule(index)}
                    />
                  </div>
                  <Select
                    label="TOOL"
                    options={matchOptions}
                    value={matchIndexForRule(rule.match)}
                    block
                    size="small"
                    disabled={disabled}
                    onChange={(selected) => updateRule(index, {
                      ...rule,
                      match: approvalOptionValue(matchOptions[selected] ?? matchOptions[0] ?? "fs.*"),
                    })}
                  />
                  <Select
                    label="MACHINE"
                    info={MACHINE_INFO}
                    options={targetOptions}
                    value={targetIndexForRule(rule.target, targets)}
                    block
                    size="small"
                    disabled={disabled}
                    onChange={(selected) => {
                      const target = approvalOptionValue(targetOptions[selected] ?? targetOptions[0] ?? "");
                      updateRule(index, target
                        ? { ...rule, target }
                        : { match: rule.match, action: rule.action });
                    }}
                  />
                  <Select
                    label="ACTION"
                    info={ACTION_INFO}
                    options={APPROVAL_ACTIONS.map((action: AgentToolApprovalAction) => ({
                      label: actionLabel(action),
                      value: action,
                    }))}
                    value={actionIndex(rule.action)}
                    block
                    size="small"
                    disabled={disabled}
                    onChange={(selected) => updateRule(index, {
                      ...rule,
                      action: APPROVAL_ACTIONS[selected] ?? "ask",
                    })}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="gsv-tools-empty gsv-paragraph-small">
          No overrides yet. Add one to set a specific rule for a tool or machine.
        </p>
        )}
      </div>
    </section>
  );
}
