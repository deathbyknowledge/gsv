import { ConsoleDetailPage } from "../../app/features/gsv-console/components/ConsoleDetailPage";
import type { Story } from "../story";

/** Renders the REAL ConsoleDetailPage so the three-row detail layout (breadcrumb
 *  + list-page SectionHeader + action bar) can be reviewed against mock data. */
const story: Story = {
  title: "Console detail header",
  group: "Templates",
  blurb: "object detail · header (title + status) · action bar (tile + description + action)",
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "40px" }}>
      {/* MACHINE — no primary action */}
      <div class="ds-template-frame">
        <ConsoleDetailPage
          icon="computer"
          title="rearden-prime"
          typeLabel="GSV · MACHINE"
          statusLabel="ONLINE"
          tone="online"
          blurb="linux x86_64 · v0.80.2 · root · last seen 2m ago"
          parentLabel="MACHINES"
          onBack={() => undefined}
          sections={[
            {
              title: "MACHINE",
              meta: "ONLINE",
              rows: [
                { id: "device", label: "DEVICE ID", sub: "rearden-prime" },
                { id: "status", icon: "computer", label: "STATUS", status: "online", statusLabel: "ONLINE", sub: "reachable" },
                { id: "platform", label: "PLATFORM", sub: "linux x86_64" },
                { id: "version", label: "VERSION", sub: "v0.80.2" },
                { id: "owner", label: "OWNER", sub: "root" },
              ],
            },
            {
              title: "CAPABILITIES",
              meta: "3",
              rows: [
                { id: "shell", label: "SHELL", sub: "exec" },
                { id: "files", label: "FILES", sub: "read / write" },
                { id: "net", label: "NETWORK", sub: "enabled" },
              ],
            },
          ]}
        />
      </div>

      {/* INTEGRATION — primary REFRESH */}
      <div class="ds-template-frame">
        <ConsoleDetailPage
          icon="weblink"
          title="github"
          typeLabel="GSV · INTEGRATION"
          statusLabel="READY"
          tone="online"
          blurb="MCP server · 12 tools · 4 resources · connected over sse"
          parentLabel="INTEGRATIONS"
          primaryLabel="REFRESH"
          onPrimary={() => undefined}
          onBack={() => undefined}
          sections={[
            {
              title: "CONNECTION",
              meta: "READY",
              rows: [
                { id: "id", label: "SERVER ID", sub: "mcp-github" },
                { id: "url", label: "URL", sub: "https://mcp.github.dev/sse" },
                { id: "status", icon: "weblink", label: "STATUS", status: "online", statusLabel: "READY", sub: "connected" },
                { id: "transport", label: "TRANSPORT", sub: "sse" },
              ],
            },
            {
              title: "INVENTORY",
              meta: "12 TOOLS",
              rows: [
                { id: "tools", label: "TOOLS", sub: "12" },
                { id: "resources", label: "RESOURCES", sub: "4" },
                { id: "prompts", label: "PROMPTS", sub: "2" },
              ],
            },
          ]}
        />
      </div>

      {/* MESSENGER — primary RECONNECT */}
      <div class="ds-template-frame">
        <ConsoleDetailPage
          icon="chat"
          title="@gsv_captain"
          typeLabel="GSV · MESSENGER"
          statusLabel="CONNECTED"
          tone="online"
          blurb="telegram · bot · authenticated · 3 linked identities"
          parentLabel="MESSENGERS"
          primaryLabel="RECONNECT"
          onPrimary={() => undefined}
          onBack={() => undefined}
          sections={[
            {
              title: "CONNECTION",
              meta: "CONNECTED",
              rows: [
                { id: "platform", icon: "chat", label: "PLATFORM", status: "online", statusLabel: "CONNECTED", sub: "telegram" },
                { id: "account", label: "ACCOUNT", sub: "@gsv_captain" },
                { id: "mode", label: "MODE", sub: "bot" },
              ],
            },
            {
              title: "LINKED IDENTITIES",
              meta: "3",
              rows: [
                { id: "l1", label: "jessicat", status: "online", statusLabel: "LINKED", sub: "uid 1000 · linked 4d ago" },
                { id: "l2", label: "builder", status: "online", statusLabel: "LINKED", sub: "uid 1001 · linked 4d ago" },
                { id: "l3", label: "xanadu", status: "online", statusLabel: "LINKED", sub: "uid 1002 · linked 2d ago" },
              ],
            },
          ]}
        />
      </div>

      {/* MODEL — primary SAVE */}
      <div class="ds-template-frame">
        <ConsoleDetailPage
          icon="stars"
          title="DEFAULT AGENT MODEL"
          typeLabel="GSV · MODELS"
          statusLabel="PERSONAL"
          tone="online"
          blurb="Your personal fallback model for agent runs. Overrides the global default for your account only."
          parentLabel="MODELS"
          primaryLabel="SAVE"
          onPrimary={() => undefined}
          onBack={() => undefined}
          sections={[
            {
              title: "MODEL",
              meta: "PERSONAL OVERRIDE",
              rows: [
                { id: "provider", label: "PROVIDER", sub: "zai-org" },
                { id: "model", label: "MODEL", sub: "glm-5.2" },
                { id: "reasoning", label: "REASONING", sub: "default" },
                { id: "context", label: "MAX CONTEXT", sub: "256000 tokens" },
              ],
            },
          ]}
        />
      </div>
    </div>
  ),
};

export default story;
