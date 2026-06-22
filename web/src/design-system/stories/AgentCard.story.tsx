import { AgentCard } from "../../app/components/ui/AgentCard";
import type { Story } from "../story";

const story: Story = {
  title: "AgentCard",
  group: "Composite",
  blurb: "crew card · Avatar + Select + Segmented · inline tasks dropdown",
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "24px", alignItems: "start" }}>
      <div class="ds-cell">
        <div class="ds-label">Active (default crew)</div>
        <div style={{ width: "320px" }}>
          <AgentCard />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Inactive — SWITCH affordance</div>
        <div style={{ width: "320px" }}>
          <AgentCard
            active={false}
            agentName="Orpheus"
            agentRole="RESEARCH AGENT"
            status="idle"
            imgSrc="/img/agent-1.png"
            modelIsDefault={false}
            description="Digs through sources, keeps the library current. Quiet until summoned."
            tasksTotal={4}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">Error status + saved flag</div>
        <div style={{ width: "320px" }}>
          <AgentCard
            agentName="Cassius"
            agentRole="OPS AGENT"
            status="error"
            imgSrc="/img/agent-2.png"
            saved
            modelIsDefault={false}
            models={["GPT-5", "Claude Opus 4", "Nemotron 3"]}
            description="Watches the infra. Pages you when something breaks."
            tasksTotal={2}
            tasks={[
              { name: "Restarting node-3", status: "error" },
              { name: "Draining queue", status: "running" },
            ]}
          />
        </div>
      </div>
      <div class="ds-cell">
        <div class="ds-label">No actions (read-only)</div>
        <div style={{ width: "320px" }}>
          <AgentCard showActions={false} status="live" agentName="Live" agentRole="STREAMING" />
        </div>
      </div>
    </div>
  ),
};

export default story;
