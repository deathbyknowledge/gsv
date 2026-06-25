import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Stepper } from "../../../components/ui/Stepper";
import { Surface } from "../../../components/ui/Surface";
import { Tag } from "../../../components/ui/Tag";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import { useConnectConsoleAdapter } from "../hooks/useConsoleData";
import { BOTFATHER_URL, MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import { adapterDetailId, adapterName, deriveTelegramAccountId } from "./messengerPresentation";
import "./MessengerOnboardingFlow.css";

type MessengerOnboardingFlowProps = {
  adapterId: string;
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function HelpLink({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <a class="gsv-messenger-help-link" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function MessengerOnboardingFlow({
  adapterId,
  onBack,
  onConnected,
}: MessengerOnboardingFlowProps): JSX.Element {
  const connect = useConnectConsoleAdapter();
  const [token, setToken] = useState("");
  const [result, setResult] = useState<ConnectConsoleAdapterResult | null>(null);
  const [formError, setFormError] = useState("");

  const isTelegram = adapterId === "telegram";
  const name = adapterName(adapterId);
  const docUrl = adapterDocUrl(adapterId);
  const connected = Boolean(result?.ok);
  const canSubmit = token.trim().length > 0 && !connect.isPending;

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setFormError("");
    setResult(null);
    try {
      const accountId = isTelegram ? deriveTelegramAccountId(token) : "main";
      const next = await connect.mutateAsync({
        adapter: adapterId,
        accountId,
        config: { botToken: token.trim() },
      });
      if (next.ok) {
        setResult(next);
        return;
      }
      setFormError(next.error || next.message);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const goToDetail = () => {
    if (!result) {
      onBack();
      return;
    }
    onConnected(adapterDetailId({
      adapter: result.adapter,
      accountId: result.accountId,
      connected: result.connected,
      authenticated: result.authenticated,
      mode: "",
      lastActivity: null,
      error: "",
      extra: {},
    }));
  };

  return (
    <section class="gsv-messenger-onboarding">
      <div class="gsv-messenger-onboarding-shell">
        <header class="gsv-messenger-onboarding-head">
          <IconButton glyph="arrowBack" size="medium" title="Back to messengers" onClick={onBack} />
          <div>
            <span class="gsv-messenger-onboarding-kicker">FLEET / NEW MESSENGER</span>
            <h2>Connect {name}</h2>
            <p>Link a {name} bot to your GSV so you can message it from anywhere.</p>
          </div>
          <Tag tone={connected ? "online" : "idle"} label={connected ? "CONNECTED" : "NOT CONNECTED"} boxed dot />
        </header>

        <div class="gsv-messenger-onboarding-stepper" aria-label="Messenger connection progress">
          <Stepper
            count={4}
            current={connected ? 3 : 2}
            l0="CREATE BOT"
            l1="GET TOKEN"
            l2="CONNECT"
            l3="ONLINE"
            width={440}
            size="small"
          />
        </div>

        {connected ? (
          <Surface class="gsv-messenger-flow-panel" level={2}>
            <SectionHeader title="MESSENGER-BOT ONLINE" meta={name.toUpperCase()} divider />
            <p class="gsv-messenger-success-lede">
              Your {name} messenger-bot is connected. Start messaging your GSV.
            </p>
            <div class="gsv-messenger-caps">
              <span class="gsv-messenger-caps-title">Things you can do with your messenger-bot</span>
              <ul class="gsv-messenger-caps-list">
                {MESSENGER_CAPABILITIES.map((cap) => (
                  <li key={cap.title}>
                    <span class="gsv-messenger-cap-title">{cap.title}</span>
                    <span class="gsv-messenger-cap-detail">{cap.detail}</span>
                  </li>
                ))}
              </ul>
              <HelpLink href={docUrl} label="Read the docs" />
            </div>
            {result?.message ? <p class="gsv-messenger-form-note">{result.message}</p> : null}
            {result?.challenge ? (
              <p class="gsv-messenger-form-note">
                This adapter returned an extra authentication step — open the bot detail to finish it.
              </p>
            ) : null}
            <div class="gsv-messenger-flow-actions">
              <Button variant="secondary" label="VIEW BOT" onClick={goToDetail} />
              <Button variant="primary" label="DONE" onClick={onBack} />
            </div>
          </Surface>
        ) : (
          <Surface class="gsv-messenger-flow-panel" level={2}>
            <SectionHeader title="CONNECT BOT" meta={name.toUpperCase()} divider />

            <ol class="gsv-messenger-steps">
              <li class="gsv-messenger-step">
                <span class="gsv-messenger-step-num">1</span>
                <div class="gsv-messenger-step-body">
                  <span class="gsv-messenger-step-title">Create your GSV messenger-bot</span>
                  <p class="gsv-messenger-step-text">
                    {isTelegram
                      ? "Open BotFather and create a new bot for your GSV."
                      : "Create a new bot application in the Discord developer portal."}
                  </p>
                  <div class="gsv-messenger-step-links">
                    {isTelegram ? <HelpLink href={BOTFATHER_URL} label="Open BotFather" /> : null}
                    <HelpLink href={docUrl} label="Don't know how? Find help here" />
                  </div>
                </div>
              </li>

              <li class="gsv-messenger-step">
                <span class="gsv-messenger-step-num">2</span>
                <div class="gsv-messenger-step-body">
                  <span class="gsv-messenger-step-title">Generate an access token to connect your bot to GSV</span>
                  <p class="gsv-messenger-step-text">
                    {isTelegram
                      ? "BotFather hands you an access token once the bot is created. Copy it."
                      : "In the bot settings, create a token and copy it."}
                  </p>
                  <div class="gsv-messenger-step-links">
                    <HelpLink href={docUrl} label="Don't know how? Find help here" />
                  </div>
                </div>
              </li>

              <li class="gsv-messenger-step">
                <span class="gsv-messenger-step-num">3</span>
                <div class="gsv-messenger-step-body">
                  <span class="gsv-messenger-step-title">Insert your access token</span>
                  <p class="gsv-messenger-step-text">Paste the token below and connect.</p>
                  <div class="gsv-messenger-token-field">
                    <TextInput
                      label="ACCESS TOKEN"
                      requirement="required"
                      value={token}
                      placeholder="123456789:AA…"
                      type="password"
                      clearable
                      status={formError ? "error" : "none"}
                      message={formError}
                      onChange={(value) => {
                        if (formError) setFormError("");
                        setToken(value);
                      }}
                      inputProps={{ name: "botToken", autoComplete: "off" }}
                    />
                  </div>
                </div>
              </li>
            </ol>

            {connect.error && !formError ? (
              <p class="gsv-messenger-form-error">{errorText(connect.error)}</p>
            ) : null}

            <div class="gsv-messenger-flow-actions">
              <Button variant="secondary" label="BACK" disabled={connect.isPending} onClick={onBack} />
              <Button
                variant="primary"
                label={connect.isPending ? "CONNECTING" : "CONNECT"}
                disabled={!canSubmit}
                onClick={submit}
              />
            </div>
          </Surface>
        )}
      </div>
    </section>
  );
}
