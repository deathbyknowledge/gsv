import { useState } from "preact/hooks";
import { useUnsavedGuard } from "../../gsv-shell/unsaved/unsavedGuard";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { Surface } from "../../../components/ui/Surface";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConsoleMcpServer } from "../domain/consoleModels";
import { useAddConsoleMcpServer } from "../hooks/useConsoleData";
import { ConnectFlowShell } from "../connect-flows/ConnectFlowShell";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import {
  MCP_TRANSPORT_OPTIONS,
  statusForMcpServer,
  transportLabel,
} from "./integrationPresentation";
import "./IntegrationOnboardingFlow.css";

type IntegrationOnboardingFlowProps = {
  onBack: () => void;
  onCreated: (server: ConsoleMcpServer) => void;
  servers: readonly ConsoleMcpServer[];
};

type HeaderDraft = {
  id: number;
  key: string;
  value: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function validUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function headersFromDrafts(rows: readonly HeaderDraft[]): { ok: true; headers?: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) {
      continue;
    }
    if (!key) {
      return { ok: false, error: "Header name required." };
    }
    if (!value) {
      return { ok: false, error: "Header value required." };
    }
    if (headers[key] !== undefined) {
      return { ok: false, error: "Header names must be unique." };
    }
    headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? { ok: true, headers } : { ok: true };
}

function HeaderFields({
  rows,
  onAdd,
  onRemove,
  onUpdate,
}: {
  rows: readonly HeaderDraft[];
  onAdd: () => void;
  onRemove: (id: number) => void;
  onUpdate: (id: number, patch: Partial<Pick<HeaderDraft, "key" | "value">>) => void;
}) {
  return (
    <div class="gsv-integration-headers">
      {rows.length === 0 ? (
        <p>No custom headers configured.</p>
      ) : rows.map((row) => (
        <div class="gsv-integration-header-row" key={row.id}>
          <TextInput
            label="HEADER NAME"
            placeholder="Authorization"
            value={row.key}
            clearable
            onChange={(value) => onUpdate(row.id, { key: value })}
          />
          <TextInput
            label="VALUE"
            placeholder="Bearer token"
            value={row.value}
            clearable
            type="password"
            onChange={(value) => onUpdate(row.id, { value })}
          />
          <Button variant="dangerGhost" label="REMOVE" onClick={() => onRemove(row.id)} />
        </div>
      ))}
      <div class="gsv-integration-header-actions">
        <Button variant="secondary" label="ADD HEADER" onClick={onAdd} />
      </div>
    </div>
  );
}

export function IntegrationOnboardingFlow({
  onBack,
  onCreated,
  servers,
}: IntegrationOnboardingFlowProps) {
  const addServer = useAddConsoleMcpServer();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transportIndex, setTransportIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [createdServerId, setCreatedServerId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [authOpened, setAuthOpened] = useState(false);
  const created = createdServerId
    ? servers.find((server) => server.serverId === createdServerId)
      ?? (addServer.data?.serverId === createdServerId ? addServer.data : null)
    : null;
  const transport = MCP_TRANSPORT_OPTIONS[transportIndex] ?? "auto";
  const urlReady = validUrl(url);
  const headersResult = headersFromDrafts(headers);
  const canSubmit = name.trim().length > 0 && urlReady && headersResult.ok && !addServer.isPending;
  const ready = created?.state === "ready";
  const failed = !!created && (created.state === "failed" || created.error.length > 0);
  let progressMessage = "";
  if (created && !ready && !failed) {
    if (created.state === "authenticating") {
      progressMessage = authOpened ? "Waiting for browser sign-in to finish." : "";
    } else if (created.state === "discovering") {
      progressMessage = "Discovering tools.";
    } else {
      progressMessage = authOpened
        ? "Sign-in received. Finishing the connection."
        : "Connecting to the server.";
    }
  }

  useUnsavedGuard(() =>
    !(created && (created.state === "ready" || created.state === "failed")) &&
    (created !== null ||
      name.trim().length > 0 ||
      url.trim().length > 0 ||
      transportIndex !== 0 ||
      headers.some((row) => row.key.trim().length > 0 || row.value.trim().length > 0))
  );

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setFormError("");
    setAuthOpened(false);
    setCreatedServerId(null);
    try {
      const server = await addServer.mutateAsync({
        name,
        url,
        transport,
        headers: headersResult.ok ? headersResult.headers : undefined,
      });
      setCreatedServerId(server.serverId);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const updateHeader = (id: number, patch: Partial<Pick<HeaderDraft, "key" | "value">>) => {
    setHeaders((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  };

  const addHeader = () => {
    setHeaders((current) => [...current, { id: Date.now() + current.length, key: "", value: "" }]);
  };

  const removeHeader = (id: number) => {
    setHeaders((current) => current.filter((row) => row.id !== id));
  };

  const openSignIn = (server: ConsoleMcpServer) => {
    if (!server.authUrl) {
      return;
    }
    setAuthOpened(true);
    window.open(server.authUrl, "_blank", "noopener,noreferrer");
  };

  // Drive the stepper from live connection state: pending auth/discovery stays
  // on step 1; only a ready server reaches the success step.
  // The Stepper is a progress indicator only — footer buttons drive transitions.
  const current = !created ? 0 : ready ? 2 : 1;

  // Step 1 status: while the form is on screen, "AUTHENTICATING" only once the
  // submit kicks off; otherwise show the connection's live state when created.
  const endpointStatus = created
    ? statusForMcpServer(created)
    : addServer.isPending
      ? "AUTHENTICATING"
      : "NOT CONNECTED";

  const flow: ConnectFlowDef = {
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
        status: endpointStatus,
        tone: "idle",
        render: () => (
          <>
            <div class="gsv-cf-fields">
              <TextInput
                label="NAME"
                info="Display name agents will see."
                requirement="required"
                value={name}
                placeholder="GitHub"
                clearable
                onChange={setName}
                inputProps={{ required: true, name: "name" }}
              />
              <TextInput
                label="SERVER URL"
                info="MCP endpoint URL."
                requirement="required"
                status={!url || urlReady ? "none" : "error"}
                message={!url || urlReady ? "" : "Enter an http(s) URL."}
                value={url}
                placeholder="https://example.com/mcp"
                clearable
                onChange={setUrl}
                inputProps={{ required: true, name: "url", inputMode: "url" }}
              />
            </div>

            <div class="gsv-integration-advanced-toggle">
              <Button
                variant="secondary"
                label={advancedOpen ? "HIDE ADVANCED" : "SHOW ADVANCED"}
                onClick={() => setAdvancedOpen((open) => !open)}
              />
            </div>

            {advancedOpen ? (
              <Surface class="gsv-integration-advanced" level={1}>
                <div class="gsv-cf-fields">
                  <Select
                    label="TRANSPORT"
                    info="Auto works for most MCP servers."
                    requirement="optional"
                    options={MCP_TRANSPORT_OPTIONS.map(transportLabel)}
                    value={transportIndex}
                    onChange={setTransportIndex}
                  />
                </div>
                <HeaderFields rows={headers} onAdd={addHeader} onRemove={removeHeader} onUpdate={updateHeader} />
                {!headersResult.ok ? <p class="gsv-integration-form-error gsv-prose">{headersResult.error}</p> : null}
              </Surface>
            ) : null}

            {formError || addServer.error ? (
              <p class="gsv-integration-form-error gsv-prose">{formError || errorText(addServer.error)}</p>
            ) : null}

            <div class="gsv-cf-footer">
              <Button variant="secondary" label="CANCEL" onClick={onBack} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={addServer.isPending ? "CONNECTING" : "CONNECT"}
                disabled={!canSubmit}
                onClick={submit}
              />
            </div>
          </>
        ),
      },
      {
        key: "connect",
        label: "CONNECT",
        title: "CONNECT & AUTHORIZE",
        meta: "STEP 2 / 3",
        status: created ? statusForMcpServer(created) : "AUTHENTICATING",
        tone: failed ? "error" : "warn",
        render: () => (
          <>
            {created?.state === "authenticating" && created.authUrl ? (
              <Surface class="gsv-integration-auth-panel" level={1}>
                <p>This server needs a browser sign-in before tools can be discovered.</p>
                <Button
                  variant="primary"
                  label={authOpened ? "OPEN SIGN-IN AGAIN" : "CONTINUE SIGN-IN"}
                  onClick={() => openSignIn(created)}
                />
              </Surface>
            ) : null}

            {progressMessage ? (
              <div class="gsv-integration-waiting gsv-prose-sm" role="status">
                <Spinner size={15} />
                <span>{progressMessage}</span>
              </div>
            ) : null}

            {created && !failed ? (
              <p class="gsv-integration-form-note gsv-prose">{created.name} · {statusForMcpServer(created)}</p>
            ) : null}

            {failed && created ? (
              <p class="gsv-integration-form-error gsv-prose">
                {created.error || "The MCP server connection failed."}
              </p>
            ) : null}

            <div class="gsv-cf-footer">
              <span class="gsv-cf-footer-spacer" />
              {failed && created ? (
                <Button variant="primary" label="VIEW INTEGRATION" onClick={() => onCreated(created)} />
              ) : null}
            </div>
          </>
        ),
      },
      {
        key: "tools",
        label: "TOOLS",
        title: "TOOLS DISCOVERED",
        meta: "STEP 3 / 3",
        status: created ? statusForMcpServer(created) : "READY",
        tone: "online",
        render: () => (
          <>
            {created ? (
              <div class="gsv-cf-cap">
                <span class="gsv-cf-cap-mark">
                  <Icon name="weblink" size={22} title={created.name} />
                </span>
                <span class="gsv-cf-cap-text">
                  <span class="gsv-cf-cap-title">{created.name} is ready</span>
                  <span class="gsv-cf-cap-sub">{statusForMcpServer(created)}</span>
                </span>
              </div>
            ) : null}

            <div class="gsv-cf-footer">
              <span class="gsv-cf-footer-spacer" />
              {created ? (
                <Button variant="primary" label="VIEW INTEGRATION" onClick={() => onCreated(created)} />
              ) : null}
            </div>
          </>
        ),
      },
    ],
  };

  return <ConnectFlowShell flow={flow} current={current} onStep={() => {}} />;
}
