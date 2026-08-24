import { useMemo } from "preact/hooks";
import { actionLabel } from "../../../components/ui/agentToolApprovalOptions";
import {
  behaviorForAccount,
  inheritedFallbackModelLabelForAccount,
  inheritedModelLabelForAccount,
  inheritedReasoningForAccount,
  parseApprovalPolicy,
} from "../domain/consoleAgentBehavior";
import type { ConsoleAccount, ConsoleConfigEntry } from "../domain/consoleModels";
import { useConsoleAgentContext } from "../hooks/useConsoleData";
import { DefaultsSummaryPanel } from "./DefaultsSummaryPanel";

export interface CrewDefaultsPanelProps {
  /** The viewer (human) account whose defaults apply to all their agents. */
  viewer: ConsoleAccount;
  config: readonly ConsoleConfigEntry[];
  /** Narrow-panel mode: the summary renders as a collapsed disclosure. */
  compact: boolean;
  /** Open the in-body edit surface (list column) on its defaults / overrides /
   *  context (global instructions) section. */
  onEditDefaults?: () => void;
  onConfigureOverrides?: () => void;
  onManageContext?: () => void;
}

function reasoningDisplayLabel(value: string): string {
  if (!value) return "—";
  if (value === "xhigh") return "Extra high";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** CrewDefaultsPanel — the "DEFAULTS" block of the CREW action column: a
 *  read-only summary of the viewer's effective defaults. Every row opens the
 *  in-body edit surface on its matching section (defaults / overrides / global
 *  instructions). */
export function CrewDefaultsPanel({
  viewer,
  config,
  compact,
  onEditDefaults,
  onConfigureOverrides,
  onManageContext,
}: CrewDefaultsPanelProps) {
  const context = useConsoleAgentContext(viewer.username);

  const behavior = behaviorForAccount(config, viewer.uid, viewer.uid);
  const savedPolicy = useMemo(() => parseApprovalPolicy(behavior.approval), [behavior.approval]);

  const modelValue = behavior.modelLabel || inheritedModelLabelForAccount(config, viewer.uid, viewer.uid) || "—";
  const fallbackValue = behavior.fallbackModelLabel
    || inheritedFallbackModelLabelForAccount(config, viewer.uid, viewer.uid)
    || "None";
  const reasoningValue = reasoningDisplayLabel(
    behavior.reasoning || inheritedReasoningForAccount(config, viewer.uid, viewer.uid),
  );
  const contextFilesCount = context.resource.isLoading || context.resource.isUnavailable || context.resource.isError
    ? null
    : context.files.length;

  return (
    <DefaultsSummaryPanel
      model={modelValue}
      fallback={fallbackValue}
      reasoning={reasoningValue}
      permissionsAction={actionLabel(savedPolicy.default).toUpperCase()}
      overridesCount={savedPolicy.rules.length}
      contextFilesCount={contextFilesCount}
      onEditDefaults={onEditDefaults}
      onConfigureOverrides={onConfigureOverrides}
      onManageContext={onManageContext}
      compact={compact}
    />
  );
}
