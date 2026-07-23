import { useState } from "preact/hooks";
import {
  AgentToolsPanel,
  type AgentToolApprovalPolicy,
  type AgentToolTarget,
} from "../../app/components/ui/AgentToolsPanel";
import type { Story } from "../story";

const TARGETS: readonly AgentToolTarget[] = [
  { id: "gsv", label: "GSV computer", online: true },
  { id: "targets/build-01", label: "BUILD-01", online: true },
  { id: "targets/edge-02", label: "EDGE-02", online: false },
];

/** Stateful wrapper so the Segmented/Select/delete controls actually respond. */
function PolicyPanel({
  policy: initial,
  sourceLabel,
  targets,
  disabled,
}: {
  policy: AgentToolApprovalPolicy;
  sourceLabel?: string;
  targets?: readonly AgentToolTarget[];
  disabled?: boolean;
}) {
  const [policy, setPolicy] = useState<AgentToolApprovalPolicy>(initial);
  return (
    <div style={{ maxWidth: 720 }}>
      <AgentToolsPanel
        policy={policy}
        sourceLabel={sourceLabel}
        targets={targets}
        disabled={disabled}
        onChange={setPolicy}
      />
    </div>
  );
}

const story: Story = {
  title: "Agent Tools Panel",
  group: "Composite",
  blurb: "tool approval policy · ALLOW/ASK/BLOCK default · read-only overrides w/ pencil-edit + ✕ · new rule pins on top, one row open at a time · composes Segmented/Select/InfoTip",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Default ALLOW · override rows (allow / ask / block)</div>
        <PolicyPanel
          targets={TARGETS}
          policy={{
            default: "auto",
            rules: [
              { match: "shell.*", action: "ask" },
              { match: "fs.delete", action: "deny" },
              { match: "net.fetch", target: "gsv", action: "auto" },
            ],
          }}
        />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Default ASK · source tag + machine-scoped overrides</div>
        <PolicyPanel
          sourceLabel="account default"
          targets={TARGETS}
          policy={{
            default: "ask",
            rules: [
              { match: "fs.read", action: "auto" },
              { match: "repo.apply", target: "targets/build-01", action: "ask" },
              { match: "sys.config.set", action: "deny" },
            ],
          }}
        />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Default BLOCK · single allow override</div>
        <PolicyPanel
          targets={TARGETS}
          policy={{
            default: "deny",
            rules: [{ match: "fs.read", action: "auto" }],
          }}
        />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Empty (no overrides)</div>
        <PolicyPanel targets={TARGETS} policy={{ default: "ask", rules: [] }} />
      </div>
      <div class="ds-cell">
        <div class="ds-label">Disabled (read-only)</div>
        <PolicyPanel
          disabled
          targets={TARGETS}
          policy={{
            default: "ask",
            rules: [
              { match: "shell.exec", action: "deny" },
              { match: "fs.write", target: "gsv", action: "ask" },
            ],
          }}
        />
      </div>
    </div>
  ),
};

export default story;
