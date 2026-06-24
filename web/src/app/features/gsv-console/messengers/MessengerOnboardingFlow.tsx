import { useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { IconButton } from "../../../components/ui/IconButton";
import { ListRow } from "../../../components/ui/ListRow";
import { Select } from "../../../components/ui/Select";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Stepper } from "../../../components/ui/Stepper";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import { listRowStatusForTone } from "../components/consoleDetailRows";
import type { ConsoleAdapter } from "../domain/consoleModels";
import { useConnectConsoleAdapter } from "../hooks/useConsoleData";
import {
  adapterDetailId,
  adapterName,
  iconForAdapterName,
  statusForAdapterFamily,
  toneForAdapterFamily,
} from "./messengerPresentation";
import "./MessengerOnboardingFlow.css";

type MessengerOnboardingFlowProps = {
  adapters: readonly ConsoleAdapter[];
  initialAccountId?: string | null;
  initialAdapter?: string | null;
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

type Challenge = NonNullable<ConnectConsoleAdapterResult["challenge"]>;

function defaultAccountId(adapter: string): string {
  if (adapter === "discord") return "main";
  if (adapter === "telegram") return "bot";
  return "primary";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function validUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function buildAdapterConfig(args: {
  adapter: string;
  botToken: string;
  forcePairing: boolean;
  webhookBaseUrl: string;
  webhookSecret: string;
}): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (args.adapter === "whatsapp") {
    config.force = args.forcePairing;
  }
  if ((args.adapter === "discord" || args.adapter === "telegram") && args.botToken.trim()) {
    config.botToken = args.botToken.trim();
  }
  if (args.adapter === "telegram" && args.webhookBaseUrl.trim()) {
    config.webhookBaseUrl = args.webhookBaseUrl.trim();
  }
  if (args.adapter === "telegram" && args.webhookSecret.trim()) {
    config.webhookSecret = args.webhookSecret.trim();
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function ChallengePanel({ challenge }: { challenge: Challenge }) {
  const isImage = /^data:image\//i.test(challenge.data);
  return (
    <Surface class="gsv-messenger-challenge" level={1}>
      <SectionHeader title={challenge.type === "qr" ? "PAIR DEVICE" : "NEXT STEP"} meta={challenge.type.toUpperCase()} divider />
      <p>{challenge.message || "Complete the adapter authentication step, then check account status."}</p>
      {challenge.data ? (
        isImage ? (
          <img src={challenge.data} alt="Adapter authentication challenge" />
        ) : (
          <pre>{challenge.data}</pre>
        )
      ) : null}
      {challenge.expiresAt ? <small>EXPIRES {new Date(challenge.expiresAt).toLocaleString()}</small> : null}
    </Surface>
  );
}

export function MessengerOnboardingFlow({
  adapters,
  initialAccountId = null,
  initialAdapter = null,
  onBack,
  onConnected,
}: MessengerOnboardingFlowProps) {
  const availableAdapters = adapters.filter((adapter) => adapter.available && adapter.supportsConnect);
  const selectableAdapters = availableAdapters.length > 0 ? availableAdapters : adapters;
  const initialIndex = Math.max(0, selectableAdapters.findIndex((adapter) => adapter.adapter === initialAdapter));
  const connect = useConnectConsoleAdapter();
  const [adapterIndex, setAdapterIndex] = useState(initialIndex);
  const selectedAdapter = selectableAdapters[adapterIndex] ?? selectableAdapters[0] ?? null;
  const selectedAdapterId = selectedAdapter?.adapter ?? "";
  const initialAccount = initialAccountId?.trim() || defaultAccountId(selectedAdapterId);
  const [accountId, setAccountId] = useState(initialAccount);
  const [accountTouched, setAccountTouched] = useState(Boolean(initialAccountId?.trim()));
  const [botToken, setBotToken] = useState("");
  const [forcePairing, setForcePairing] = useState(false);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [result, setResult] = useState<ConnectConsoleAdapterResult | null>(null);
  const [formError, setFormError] = useState("");
  const webhookValid = validUrl(webhookBaseUrl);
  const canSubmit = Boolean(selectedAdapterId && accountId.trim()) && webhookValid && !connect.isPending;
  const currentStep = result?.challenge ? 2 : accountId.trim() ? 1 : 0;
  const options = selectableAdapters.map((adapter) => adapterName(adapter.adapter));

  const selectedRow = useMemo(() => selectedAdapter ? {
    icon: iconForAdapterName(selectedAdapter.adapter),
    label: adapterName(selectedAdapter.adapter),
    status: listRowStatusForTone(toneForAdapterFamily(selectedAdapter)),
    statusLabel: statusForAdapterFamily(selectedAdapter),
    sub: selectedAdapter.available
      ? `${selectedAdapter.accounts.length} configured account${selectedAdapter.accounts.length === 1 ? "" : "s"}`
      : "Adapter worker not deployed",
  } : null, [selectedAdapter]);

  const selectAdapter = (index: number) => {
    const next = selectableAdapters[index] ?? null;
    setAdapterIndex(index);
    setResult(null);
    setFormError("");
    if (next && !accountTouched) {
      setAccountId(next.adapter === initialAdapter && initialAccountId?.trim() ? initialAccountId.trim() : defaultAccountId(next.adapter));
    }
  };

  const submit = async () => {
    if (!selectedAdapter || !canSubmit) {
      return;
    }
    setFormError("");
    setResult(null);
    try {
      const next = await connect.mutateAsync({
        adapter: selectedAdapter.adapter,
        accountId,
        config: buildAdapterConfig({
          adapter: selectedAdapter.adapter,
          botToken,
          forcePairing,
          webhookBaseUrl,
          webhookSecret,
        }),
      });
      setResult(next);
      if (!next.ok) {
        setFormError(next.error || next.message);
        return;
      }
      if (!next.challenge) {
        onConnected(adapterDetailId({
          adapter: next.adapter,
          accountId: next.accountId,
          connected: next.connected,
          authenticated: next.authenticated,
          mode: "",
          lastActivity: null,
          error: "",
          extra: {},
        }));
      }
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  if (selectableAdapters.length === 0) {
    return (
      <section class="gsv-messenger-onboarding">
        <div class="gsv-messenger-onboarding-shell">
          <header class="gsv-messenger-onboarding-head">
            <IconButton glyph="arrowBack" size="medium" title="Back to messengers" onClick={onBack} />
            <div>
              <span class="gsv-messenger-onboarding-kicker">FLEET / NEW MESSENGER</span>
              <h2>Connect messenger</h2>
              <p>Add an external messaging account to route conversations into GSV.</p>
            </div>
            <Tag tone="idle" label="NO ADAPTERS" boxed dot />
          </header>
          <Surface class="gsv-messenger-flow-panel" level={2}>
            <SectionHeader title="ADAPTERS" meta="UNAVAILABLE" divider />
            <p>No adapter workers were discovered on this GSV instance.</p>
            <div class="gsv-messenger-flow-actions">
              <Button variant="secondary" label="BACK TO MESSENGERS" onClick={onBack} />
            </div>
          </Surface>
        </div>
      </section>
    );
  }

  return (
    <section class="gsv-messenger-onboarding">
      <div class="gsv-messenger-onboarding-shell">
        <header class="gsv-messenger-onboarding-head">
          <IconButton glyph="arrowBack" size="medium" title="Back to messengers" onClick={onBack} />
          <div>
            <span class="gsv-messenger-onboarding-kicker">FLEET / NEW MESSENGER</span>
            <h2>Connect messenger</h2>
            <p>Add an external messaging account to route conversations into GSV.</p>
          </div>
          <Tag tone={result?.ok ? "online" : "idle"} label={result?.ok ? "CONNECTED" : "NOT CONFIGURED"} boxed dot />
        </header>

        <div class="gsv-messenger-onboarding-stepper" aria-label="Messenger connection progress">
          <Stepper count={3} current={currentStep} l0="ADAPTER" l1="ACCOUNT" l2="AUTH" width={420} size="small" />
        </div>

        <Surface class="gsv-messenger-flow-panel" level={2}>
          <SectionHeader title="ACCOUNT" meta={selectedAdapter ? adapterName(selectedAdapter.adapter).toUpperCase() : "ADAPTER"} divider />
          <div class="gsv-messenger-form-grid">
            <Select
              label="ADAPTER"
              description="Only deployed adapter workers can create new accounts."
              requirement="required"
              options={options}
              value={adapterIndex}
              onChange={selectAdapter}
            />
            {selectedRow ? (
              <ListRow
                icon={selectedRow.icon}
                label={selectedRow.label}
                status={selectedRow.status}
                statusDotPlacement="trailing"
                statusLabel={selectedRow.statusLabel}
                sub={selectedRow.sub}
              />
            ) : null}
            <TextInput
              label="ACCOUNT ID"
              description="Local account handle for this adapter."
              requirement="required"
              value={accountId}
              placeholder={defaultAccountId(selectedAdapterId)}
              clearable
              onChange={(value) => {
                setAccountTouched(true);
                setAccountId(value);
              }}
              inputProps={{ required: true, name: "accountId" }}
            />

            {selectedAdapterId === "whatsapp" ? (
              <Checkbox
                checked={forcePairing}
                label="FORCE FRESH QR SESSION"
                description="Start a fresh pairing session even if cached state exists."
                onChange={setForcePairing}
              />
            ) : selectedAdapterId === "discord" || selectedAdapterId === "telegram" ? (
              <TextInput
                label="BOT TOKEN"
                description="Optional when the adapter worker has a deployment token configured."
                requirement="optional"
                value={botToken}
                placeholder="Use deployment default"
                type="password"
                clearable
                onChange={setBotToken}
                inputProps={{ name: "botToken", autoComplete: "off" }}
              />
            ) : null}

            {selectedAdapterId === "telegram" ? (
              <>
                <TextInput
                  label="WEBHOOK BASE URL"
                  description="Needed only when the adapter worker has no deployment default."
                  requirement="optional"
                  status={webhookValid ? "none" : "error"}
                  message={webhookValid ? "" : "Enter an http(s) URL or leave blank."}
                  value={webhookBaseUrl}
                  placeholder="https://telegram-adapter.example.com"
                  clearable
                  onChange={setWebhookBaseUrl}
                  inputProps={{ name: "webhookBaseUrl", inputMode: "url" }}
                />
                <TextInput
                  label="WEBHOOK SECRET"
                  description="Leave blank to use the worker default."
                  requirement="optional"
                  value={webhookSecret}
                  placeholder="Use deployment default"
                  type="password"
                  clearable
                  onChange={setWebhookSecret}
                  inputProps={{ name: "webhookSecret", autoComplete: "off" }}
                />
              </>
            ) : null}
          </div>

          {formError || connect.error ? (
            <p class="gsv-messenger-form-error">{formError || errorText(connect.error)}</p>
          ) : result?.message ? (
            <p class="gsv-messenger-form-note">{result.message}</p>
          ) : null}

          {result?.challenge ? <ChallengePanel challenge={result.challenge} /> : null}

          <div class="gsv-messenger-flow-actions">
            <Button variant="secondary" label="BACK" disabled={connect.isPending} onClick={onBack} />
            {result?.ok ? (
              <Button
                variant="primary"
                label="VIEW ACCOUNT"
                onClick={() => onConnected(adapterDetailId({
                  adapter: result.adapter,
                  accountId: result.accountId,
                  connected: result.connected,
                  authenticated: result.authenticated,
                  mode: "",
                  lastActivity: null,
                  error: "",
                  extra: {},
                }))}
              />
            ) : (
              <Button
                variant="primary"
                label={connect.isPending ? "CONNECTING" : selectedAdapterId === "whatsapp" ? "PAIR" : "CONNECT"}
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
