import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow } from "../../../components/ui/ListRow";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConnectFlowDef, ConnectNav } from "./connectFlowTypes";

/** Footer button row shared by the steps. `primaryLabel`/`onPrimary` override
 *  the default CONTINUE→onNext primary action (e.g. inert DONE). */
function Footer({
  nav,
  primaryLabel = "CONTINUE",
  onPrimary,
}: {
  nav: ConnectNav;
  primaryLabel?: string;
  onPrimary?: () => void;
}) {
  return (
    <div class="gsv-cf-footer">
      <Button variant="secondary" label="BACK" onClick={nav.onBack} />
      <span class="gsv-cf-footer-spacer" />
      <Button variant="primary" label={primaryLabel} onClick={onPrimary ?? nav.onNext} />
    </div>
  );
}

const DISCOVERED_TOOLS: { name: string; sub: string }[] = [
  { name: "create_issue", sub: "Open a new GitHub issue in a repository." },
  { name: "list_repos", sub: "List repositories the account can access." },
  { name: "get_pull_request", sub: "Fetch a pull request with its files and reviews." },
  { name: "search_code", sub: "Search code across repositories by query." },
];

export const integrationConnectFlow: ConnectFlowDef = {
  key: "integrations",
  navLabel: "INTEGRATIONS",
  parentLabel: "INTEGRATIONS",
  icon: "weblink",
  title: "Connect MCP server",
  blurb:
    "Attach a remote tool server and make its tools available to agents through CodeMode · point GSV at an MCP endpoint.",
  steps: [
    {
      key: "endpoint",
      label: "ENDPOINT",
      title: "SERVER ENDPOINT",
      meta: "STEP 1 / 3",
      status: "NOT CONNECTED",
      tone: "idle",
      render: (nav) => (
        <>
          <div class="gsv-cf-fields">
            <TextInput
              label="NAME"
              description="Display name agents will see."
              requirement="required"
              value="GitHub"
              placeholder="GitHub"
              clearable
            />
            <TextInput
              label="SERVER URL"
              description="MCP endpoint URL."
              requirement="required"
              value="https://api.githubcopilot.com/mcp/"
              placeholder="https://example.com/mcp"
              clearable
            />
          </div>

          <div class="gsv-cf-fields">
            <Select
              label="TRANSPORT"
              description="Auto works for most MCP servers."
              requirement="optional"
              options={["AUTO", "STREAMABLE HTTP", "SSE"]}
              value={0}
            />
          </div>

          <div class="gsv-cf-fields">
            <TextInput
              label="HEADER NAME"
              description="Custom header sent on every request."
              value="Authorization"
              placeholder="Authorization"
              clearable
            />
            <TextInput
              label="VALUE"
              description="Header value."
              type="password"
              value="Bearer ghp_mock"
              placeholder="Bearer token"
              clearable
            />
          </div>

          <div class="gsv-cf-footer">
            <Button variant="secondary" label="CANCEL" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="CONTINUE" onClick={nav.onNext} />
          </div>
        </>
      ),
    },
    {
      key: "connect",
      label: "CONNECT",
      title: "CONNECT & AUTHORIZE",
      meta: "STEP 2 / 3",
      status: "AUTHENTICATING",
      tone: "warn",
      render: (nav) => (
        <>
          <Alert
            variant="attention"
            title="SIGN-IN REQUIRED"
            text="GitHub needs you to authorize GSV in a browser tab to finish connecting."
          />
          <p class="gsv-cf-cap-sub" style={{ margin: 0 }}>
            We'll open the provider's OAuth page. Once you approve access, GSV
            discovers the server's tools automatically.
          </p>
          <Footer nav={nav} primaryLabel="CONTINUE SIGN-IN" />
        </>
      ),
    },
    {
      key: "tools",
      label: "TOOLS",
      title: "TOOLS DISCOVERED",
      meta: "STEP 3 / 3",
      status: "READY",
      tone: "online",
      render: (nav) => (
        <>
          <div class="gsv-cf-cap">
            <span class="gsv-cf-cap-mark">
              <Icon name="weblink" size={22} title="GitHub" />
            </span>
            <span class="gsv-cf-cap-text">
              <span class="gsv-cf-cap-title">GitHub is ready</span>
              <span class="gsv-cf-cap-sub">
                12 tools · 4 resources now available to your agents.
              </span>
            </span>
          </div>

          <div class="gsv-cf-framed">
            {DISCOVERED_TOOLS.map((tool) => (
              <ListRow
                key={tool.name}
                icon="weblink"
                label={tool.name}
                sub={tool.sub}
                status="online"
              />
            ))}
          </div>

          <div class="gsv-cf-footer">
            <Button variant="secondary" label="BACK" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="DONE" />
          </div>
        </>
      ),
    },
  ],
};
