import { useEffect, useMemo, useState } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { SensitiveInput } from "@cloudflare/kumo/components/sensitive-input";
import { Surface } from "@cloudflare/kumo/components/surface";
import { getGatewayUrl } from "../../ui/storage";
import { useReactUiStore } from "../state/store";

type GsvConfig = {
  model?: { provider: string; id: string };
  apiKeys?: {
    anthropic?: string;
    openai?: string;
    google?: string;
    openrouter?: string;
  };
  auth?: { token?: string };
  transcription?: { provider?: "workers-ai" | "openai" };
  channels?: {
    whatsapp?: {
      dmPolicy?: "open" | "allowlist" | "pairing";
      allowFrom?: string[];
    };
  };
  session?: {
    identityLinks?: Record<string, string[]>;
  };
  agents?: {
    defaultHeartbeat?: {
      every?: string;
      target?: string;
    };
  };
};

const MODEL_OPTIONS = [
  { provider: "anthropic", id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { provider: "anthropic", id: "claude-opus-4-20250514", label: "Claude Opus 4" },
  { provider: "openai", id: "gpt-4.1", label: "GPT-4.1" },
  { provider: "openai", id: "o3", label: "OpenAI o3" },
  { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

function parseAllowFrom(text: string): string[] {
  return text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function ConfigView() {
  const config = useReactUiStore((s) => (s.config || {}) as GsvConfig);
  const configLoading = useReactUiStore((s) => s.configLoading);
  const connectionState = useReactUiStore((s) => s.connectionState);
  const settings = useReactUiStore((s) => s.settings);
  const loadConfig = useReactUiStore((s) => s.loadConfig);
  const saveConfig = useReactUiStore((s) => s.saveConfig);
  const updateSettings = useReactUiStore((s) => s.updateSettings);

  const model = config.model || {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
  };
  const apiKeys = config.apiKeys || {};
  const auth = config.auth || {};
  const transcriptionProvider = config.transcription?.provider || "workers-ai";
  const whatsapp = config.channels?.whatsapp || { dmPolicy: "pairing", allowFrom: [] };
  const identityLinks = config.session?.identityLinks || {};
  const heartbeat = config.agents?.defaultHeartbeat || {};

  const [gatewayUrl, setGatewayUrl] = useState(settings.gatewayUrl);
  const [sessionKey, setSessionKey] = useState(settings.sessionKey);
  const [modelProvider, setModelProvider] = useState(model.provider);
  const [modelId, setModelId] = useState(model.id);
  const [anthropicKey, setAnthropicKey] = useState(apiKeys.anthropic || "");
  const [openAiKey, setOpenAiKey] = useState(apiKeys.openai || "");
  const [googleKey, setGoogleKey] = useState(apiKeys.google || "");
  const [openRouterKey, setOpenRouterKey] = useState(apiKeys.openrouter || "");
  const [authToken, setAuthToken] = useState(auth.token || "");
  const [allowFromText, setAllowFromText] = useState(
    (whatsapp.allowFrom || []).join("\n"),
  );
  const [heartbeatEvery, setHeartbeatEvery] = useState(heartbeat.every || "");
  const [newIdentityName, setNewIdentityName] = useState("");
  const [newIdentityValues, setNewIdentityValues] = useState("");

  useEffect(() => {
    setGatewayUrl(settings.gatewayUrl);
    setSessionKey(settings.sessionKey);
  }, [settings.gatewayUrl, settings.sessionKey]);

  useEffect(() => {
    setModelProvider(model.provider);
    setModelId(model.id);
  }, [model.provider, model.id]);

  useEffect(() => {
    setAnthropicKey(apiKeys.anthropic || "");
    setOpenAiKey(apiKeys.openai || "");
    setGoogleKey(apiKeys.google || "");
    setOpenRouterKey(apiKeys.openrouter || "");
  }, [apiKeys.anthropic, apiKeys.google, apiKeys.openai, apiKeys.openrouter]);

  useEffect(() => {
    setAuthToken(auth.token || "");
  }, [auth.token]);

  const allowFromValue = useMemo(
    () => (whatsapp.allowFrom || []).join("\n"),
    [whatsapp.allowFrom],
  );
  useEffect(() => {
    setAllowFromText(allowFromValue);
  }, [allowFromValue]);

  useEffect(() => {
    setHeartbeatEvery(heartbeat.every || "");
  }, [heartbeat.every]);

  const modelValue = `${model.provider}/${model.id}`;
  const modelHasQuickSelect = MODEL_OPTIONS.some(
    (option) => `${option.provider}/${option.id}` === modelValue,
  );

  const commitModel = () => {
    const provider = modelProvider.trim();
    const id = modelId.trim();
    if (!provider || !id) {
      return;
    }
    void saveConfig("model", { provider, id });
  };

  const connectionBadgeVariant = connectionState === "connected" ? "primary" : "outline";
  const textInputClassName = "ui-input-fix";
  const monoTextInputClassName = "mono ui-input-fix";
  const monoSensitiveInputClassName = "mono ui-sensitive-fix";

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Configuration</h2>
        <Button
          size="sm"
          variant="secondary"
          loading={configLoading}
          onClick={() => {
            void loadConfig();
          }}
        >
          Refresh
        </Button>
      </div>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Gateway Connection</h3>
          <Badge variant={connectionBadgeVariant}>{connectionState}</Badge>
        </div>
        <div className="card-body">
          <div className="form-group">
            <Input
              label="Gateway URL"
              className={monoTextInputClassName}
              size="lg"
              placeholder={getGatewayUrl(settings)}
              value={gatewayUrl}
              onChange={(event) => setGatewayUrl(event.target.value)}
              onBlur={() => {
                updateSettings({ gatewayUrl: gatewayUrl.trim() });
              }}
            />
            <p className="form-hint">
              {gatewayUrl.trim()
                ? "Custom WebSocket URL."
                : `Auto-derived from page URL: ${getGatewayUrl(settings)}`}
            </p>
          </div>

          <div className="form-group">
            <Input
              label="Session Key"
              className={monoTextInputClassName}
              size="lg"
              value={sessionKey}
              onChange={(event) => setSessionKey(event.target.value)}
              onBlur={() => {
                const nextSessionKey = sessionKey.trim();
                if (nextSessionKey) {
                  updateSettings({ sessionKey: nextSessionKey });
                }
              }}
              description="Format: agent:{agentId}:{channel}:{peerKind}:{peerId}"
            />
          </div>

          <Select<string>
            label="Theme"
            hideLabel={false}
            value={settings.theme}
            onValueChange={(value) =>
              updateSettings({ theme: value as "dark" | "light" | "system" })
            }
          >
            <Select.Option value="dark">Dark</Select.Option>
            <Select.Option value="light">Light</Select.Option>
            <Select.Option value="system">System</Select.Option>
          </Select>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Model</h3>
        </div>
        <div className="card-body">
          <div className="form-group">
            <Select<string>
              label="Quick Select"
              hideLabel={false}
              value={modelHasQuickSelect ? modelValue : ""}
              onValueChange={(value) => {
                const selected = String(value || "").trim();
                if (!selected.includes("/")) {
                  return;
                }
                const [provider, id] = selected.split("/");
                setModelProvider(provider);
                setModelId(id);
                void saveConfig("model", { provider, id });
              }}
              placeholder="Select a common model"
            >
              <Select.Option value="">Custom model</Select.Option>
              {MODEL_OPTIONS.map((option) => (
                <Select.Option
                  key={`${option.provider}/${option.id}`}
                  value={`${option.provider}/${option.id}`}
                >
                  {option.label} ({option.provider})
                </Select.Option>
              ))}
            </Select>
          </div>

          <div className="form-group">
            <Input
              label="Provider"
              className={monoTextInputClassName}
              size="lg"
              value={modelProvider}
              onChange={(event) => setModelProvider(event.target.value)}
              onBlur={commitModel}
              description={`Current: ${model.provider}`}
            />
          </div>

          <div className="form-group">
            <Input
              label="Model ID"
              className={monoTextInputClassName}
              size="lg"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              onBlur={commitModel}
              description={`Current: ${model.id}`}
            />
          </div>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">API Keys</h3>
        </div>
        <div className="card-body">
          <div className="form-group">
            <SensitiveInput
              label="Anthropic API Key"
              className={monoSensitiveInputClassName}
              size="lg"
              value={anthropicKey}
              onValueChange={setAnthropicKey}
              onBlur={() => {
                const value = anthropicKey.trim();
                void saveConfig("apiKeys.anthropic", value || undefined);
              }}
              placeholder="sk-ant-..."
              description={
                anthropicKey.trim()
                  ? "Configured."
                  : "Required for Claude models."
              }
            />
          </div>

          <div className="form-group">
            <SensitiveInput
              label="OpenAI API Key"
              className={monoSensitiveInputClassName}
              size="lg"
              value={openAiKey}
              onValueChange={setOpenAiKey}
              onBlur={() => {
                const value = openAiKey.trim();
                void saveConfig("apiKeys.openai", value || undefined);
              }}
              placeholder="sk-..."
              description={
                openAiKey.trim()
                  ? "Configured."
                  : "Required for GPT models and OpenAI transcription."
              }
            />
          </div>

          <div className="form-group">
            <SensitiveInput
              label="Google API Key"
              className={monoSensitiveInputClassName}
              size="lg"
              value={googleKey}
              onValueChange={setGoogleKey}
              onBlur={() => {
                const value = googleKey.trim();
                void saveConfig("apiKeys.google", value || undefined);
              }}
              placeholder="AIza..."
              description={
                googleKey.trim()
                  ? "Configured."
                  : "Required for Gemini models."
              }
            />
          </div>

          <div className="form-group">
            <SensitiveInput
              label="OpenRouter API Key"
              className={monoSensitiveInputClassName}
              size="lg"
              value={openRouterKey}
              onValueChange={setOpenRouterKey}
              onBlur={() => {
                const value = openRouterKey.trim();
                void saveConfig("apiKeys.openrouter", value || undefined);
              }}
              placeholder="sk-or-..."
              description={
                openRouterKey.trim()
                  ? "Configured."
                  : "Required for OpenRouter models."
              }
            />
          </div>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Authentication</h3>
        </div>
        <div className="card-body">
          <SensitiveInput
            label="Auth Token"
            className={monoSensitiveInputClassName}
            size="lg"
            value={authToken}
            onValueChange={setAuthToken}
            onBlur={() => {
              const value = authToken.trim();
              void saveConfig("auth.token", value || undefined);
              updateSettings({ token: value });
            }}
            placeholder="Leave empty for no authentication"
            description={
              authToken.trim()
                ? "Auth enabled for clients and nodes."
                : "Auth disabled. Any client can connect."
            }
          />
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Voice Transcription</h3>
        </div>
        <div className="card-body">
          <Select<string>
            label="Transcription Provider"
            hideLabel={false}
            value={transcriptionProvider}
            onValueChange={(value) =>
              void saveConfig("transcription.provider", String(value))
            }
          >
            <Select.Option value="workers-ai">Workers AI (Free)</Select.Option>
            <Select.Option value="openai">
              OpenAI Whisper (requires API key)
            </Select.Option>
          </Select>
          <p className="form-hint">
            Used for transcribing voice messages from WhatsApp.
          </p>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">WhatsApp Channel</h3>
        </div>
        <div className="card-body">
          <div className="form-group">
            <Select<string>
              label="DM Access Policy"
              hideLabel={false}
              value={whatsapp.dmPolicy || "pairing"}
              onValueChange={(value) =>
                void saveConfig("channels.whatsapp.dmPolicy", String(value))
              }
            >
              <Select.Option value="pairing">
                Pairing (recommended): unknown senders need approval
              </Select.Option>
              <Select.Option value="allowlist">
                Allowlist: only approved senders can message
              </Select.Option>
              <Select.Option value="open">
                Open: anyone can message (use with caution)
              </Select.Option>
            </Select>
          </div>

          <div className="form-group">
            <Textarea
              label="Allowed Numbers"
              className={monoTextInputClassName}
              size="lg"
              rows={4}
              value={allowFromText}
              onValueChange={setAllowFromText}
              onBlur={() => {
                const parsed = parseAllowFrom(allowFromText);
                void saveConfig("channels.whatsapp.allowFrom", parsed);
              }}
              placeholder={"+1234567890\n+31612345678\ngroup-id@g.us"}
            />
            <p className="form-hint">
              One entry per line. E.164 format (+1234567890) or WhatsApp JID for
              groups.
            </p>
          </div>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Identity Links</h3>
        </div>
        <div className="card-body">
          <p className="text-secondary" style={{ marginBottom: "var(--space-3)" }}>
            Link multiple identities to one session so conversations can continue
            across channels.
          </p>

          {Object.keys(identityLinks).length === 0 ? (
            <p className="muted" style={{ marginBottom: "var(--space-3)" }}>
              No identity links configured.
            </p>
          ) : (
            Object.entries(identityLinks).map(([name, ids]) => (
              <Surface
                key={name}
                className="card"
                color="secondary"
                style={{ marginBottom: "var(--space-2)" }}
              >
                <div className="card-body">
                  <div className="section-header" style={{ marginBottom: "var(--space-2)" }}>
                    <strong>{name}</strong>
                    <Button
                      size="sm"
                      variant="secondary-destructive"
                      onClick={() => {
                        const nextLinks = { ...identityLinks };
                        delete nextLinks[name];
                        void saveConfig(
                          "session.identityLinks",
                          Object.keys(nextLinks).length ? nextLinks : undefined,
                        );
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                  <code className="mono" style={{ fontSize: "var(--font-size-xs)" }}>
                    {(ids || []).join(", ")}
                  </code>
                </div>
              </Surface>
            ))
          )}

          <Surface className="card" color="secondary" style={{ marginTop: "var(--space-3)" }}>
            <div className="card-body">
              <div className="form-group">
                <Input
                  label="Canonical Name"
                  className={textInputClassName}
                  size="lg"
                  value={newIdentityName}
                  onChange={(event) => setNewIdentityName(event.target.value)}
                  placeholder="e.g., steve"
                />
              </div>
              <div className="form-group">
                <Textarea
                  label="Identities (one per line)"
                  className={monoTextInputClassName}
                  size="lg"
                  rows={3}
                  value={newIdentityValues}
                  onValueChange={setNewIdentityValues}
                  placeholder={"+1234567890\ntelegram:123456\ndiscord:username#1234"}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const name = newIdentityName.trim();
                  const values = parseAllowFrom(newIdentityValues);
                  if (!name || values.length === 0) {
                    return;
                  }
                  void saveConfig("session.identityLinks", {
                    ...identityLinks,
                    [name]: values,
                  });
                  setNewIdentityName("");
                  setNewIdentityValues("");
                }}
              >
                Add Link
              </Button>
            </div>
          </Surface>
        </div>
      </Surface>

      <Surface className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">Heartbeat</h3>
        </div>
        <div className="card-body">
          <div className="form-group">
            <Input
              label="Interval"
              className={textInputClassName}
              size="lg"
              value={heartbeatEvery}
              onChange={(event) => setHeartbeatEvery(event.target.value)}
              onBlur={() =>
                void saveConfig(
                  "agents.defaultHeartbeat.every",
                  heartbeatEvery.trim() || undefined,
                )
              }
              placeholder="e.g. 30m, 1h, 0 to disable"
              description="How often to check in. Use 30m, 1h, etc. Set to 0 to disable."
            />
          </div>

          <Select<string>
            label="Delivery Target"
            hideLabel={false}
            value={heartbeat.target || "last"}
            onValueChange={(value) =>
              void saveConfig("agents.defaultHeartbeat.target", String(value))
            }
          >
            <Select.Option value="last">Last active channel</Select.Option>
            <Select.Option value="none">No delivery (silent)</Select.Option>
          </Select>
        </div>
      </Surface>

      <Surface className="card">
        <div className="card-header">
          <h3 className="card-title">Raw Configuration</h3>
        </div>
        <div className="card-body">
          <details>
            <summary style={{ cursor: "pointer" }}>View raw JSON</summary>
            <pre style={{ marginTop: "var(--space-3)", maxHeight: 420, overflow: "auto" }}>
              <code>{JSON.stringify(config || {}, null, 2)}</code>
            </pre>
          </details>
        </div>
      </Surface>
    </div>
  );
}
