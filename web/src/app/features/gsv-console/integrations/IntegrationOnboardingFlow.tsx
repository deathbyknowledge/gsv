import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { Select } from "../../../components/ui/Select";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Stepper } from "../../../components/ui/Stepper";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConsoleMcpServer, ConsoleMcpTransport } from "../domain/consoleModels";
import { useAddConsoleMcpServer } from "../hooks/useConsoleData";
import {
  MCP_TRANSPORT_OPTIONS,
  statusForMcpServer,
  transportLabel,
} from "./integrationPresentation";
import "./IntegrationOnboardingFlow.css";

type IntegrationOnboardingFlowProps = {
  onBack: () => void;
  onCreated: (server: ConsoleMcpServer) => void;
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
            label="HEADER"
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

export function IntegrationOnboardingFlow({ onBack, onCreated }: IntegrationOnboardingFlowProps) {
  const addServer = useAddConsoleMcpServer();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transportIndex, setTransportIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [created, setCreated] = useState<ConsoleMcpServer | null>(null);
  const [formError, setFormError] = useState("");
  const transport = MCP_TRANSPORT_OPTIONS[transportIndex] ?? "auto";
  const urlReady = validUrl(url);
  const headersResult = headersFromDrafts(headers);
  const canSubmit = name.trim().length > 0 && urlReady && headersResult.ok && !addServer.isPending;
  const currentStep = created ? 2 : urlReady && name.trim() ? 1 : 0;
  const statusLabel = created ? statusForMcpServer(created) : "NOT CONFIGURED";

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setFormError("");
    setCreated(null);
    try {
      const server = await addServer.mutateAsync({
        name,
        url,
        transport,
        headers: headersResult.ok ? headersResult.headers : undefined,
      });
      setCreated(server);
      if (server.state !== "authenticating") {
        onCreated(server);
      }
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

  return (
    <section class="gsv-integration-onboarding">
      <div class="gsv-integration-onboarding-shell">
        <header class="gsv-integration-onboarding-head">
          <IconButton glyph="arrowBack" size="medium" title="Back to integrations" onClick={onBack} />
          <div>
            <span class="gsv-integration-onboarding-kicker">FLEET / NEW INTEGRATION</span>
            <h2>Connect MCP server</h2>
            <p>Attach a tool server and make its tools available to agents through CodeMode.</p>
          </div>
          <Tag tone={created?.state === "ready" ? "online" : created ? "warn" : "idle"} label={statusLabel} boxed dot />
        </header>

        <div class="gsv-integration-onboarding-stepper" aria-label="Integration connection progress">
          <Stepper count={3} current={currentStep} l0="ENDPOINT" l1="CONNECT" l2="TOOLS" width={420} size="small" />
        </div>

        <Surface class="gsv-integration-flow-panel" level={2}>
          <SectionHeader title="SERVER ENDPOINT" meta="STEP 1 / 3" divider />
          <div class="gsv-integration-form-grid">
            <TextInput
              label="NAME"
              description="Display name agents will see."
              requirement="required"
              value={name}
              placeholder="GitHub"
              clearable
              onChange={setName}
              inputProps={{ required: true, name: "name" }}
            />
            <TextInput
              label="SERVER URL"
              description="MCP endpoint URL."
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
              <SectionHeader title="ADVANCED" meta="TRANSPORT / HEADERS" divider />
              <div class="gsv-integration-form-grid">
                <Select
                  label="TRANSPORT"
                  description="Auto works for most MCP servers."
                  requirement="optional"
                  options={MCP_TRANSPORT_OPTIONS.map(transportLabel)}
                  value={transportIndex}
                  onChange={setTransportIndex}
                />
                <HeaderFields rows={headers} onAdd={addHeader} onRemove={removeHeader} onUpdate={updateHeader} />
              </div>
              {!headersResult.ok ? <p class="gsv-integration-form-error">{headersResult.error}</p> : null}
            </Surface>
          ) : null}

          {formError || addServer.error ? (
            <p class="gsv-integration-form-error">{formError || errorText(addServer.error)}</p>
          ) : created ? (
            <p class="gsv-integration-form-note">{created.name} · {statusForMcpServer(created)}</p>
          ) : null}

          {created?.state === "authenticating" && created.authUrl ? (
            <Surface class="gsv-integration-auth-panel" level={1}>
              <SectionHeader title="SIGN-IN REQUIRED" meta="OAUTH" divider />
              <p>This server needs a browser sign-in before tools can be discovered.</p>
              <Button
                variant="primary"
                label="CONTINUE SIGN-IN"
                onClick={() => window.open(created.authUrl, "_blank", "noopener,noreferrer")}
              />
            </Surface>
          ) : null}

          <div class="gsv-integration-flow-actions">
            <Button variant="secondary" label="BACK" disabled={addServer.isPending} onClick={onBack} />
            {created ? (
              <Button variant="primary" label="VIEW INTEGRATION" onClick={() => onCreated(created)} />
            ) : (
              <Button
                variant="primary"
                label={addServer.isPending ? "CONNECTING" : "CONNECT"}
                disabled={!canSubmit}
                onClick={submit}
              />
            )}
          </div>
        </Surface>
      </div>
    </section>
  );
}
