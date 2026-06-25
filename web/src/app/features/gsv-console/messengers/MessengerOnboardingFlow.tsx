import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Link } from "../../../components/ui/Link";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Stepper } from "../../../components/ui/Stepper";
import { TextInput } from "../../../components/ui/TextInput";
import { ConsoleDetailHeader } from "../components/ConsoleDetailHeader";
import type { ConnectConsoleAdapterResult } from "../backend/consoleService";
import { useConnectConsoleAdapter } from "../hooks/useConsoleData";
import { BOTFATHER_URL, MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import { adapterDetailId, adapterName, deriveTelegramAccountId, iconForAdapterName } from "./messengerPresentation";
import "./MessengerOnboardingFlow.css";

type MessengerOnboardingFlowProps = {
  adapterId: string;
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

/** Step indices for the progressive-disclosure wizard. */
const STEP_CREATE = 0;
const STEP_TOKEN = 1;
const STEP_CONNECT = 2;
const STEP_ONLINE = 3;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

export function MessengerOnboardingFlow({
  adapterId,
  onBack,
  onConnected,
}: MessengerOnboardingFlowProps): JSX.Element {
  const connect = useConnectConsoleAdapter();
  const [step, setStep] = useState(STEP_CREATE);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<ConnectConsoleAdapterResult | null>(null);
  const [formError, setFormError] = useState("");

  const isTelegram = adapterId === "telegram";
  const name = adapterName(adapterId);
  const docUrl = adapterDocUrl(adapterId);
  const connected = step === STEP_ONLINE;
  const canSubmit = token.trim().length > 0 && !connect.isPending;
  // Steps 1-2 are performed on the messaging platform; 3-4 happen inside GSV.
  const onPlatform = step <= STEP_TOKEN;

  const goNext = () => setStep((current) => Math.min(current + 1, STEP_CONNECT));
  const goBack = () => {
    if (step === STEP_CREATE) {
      onBack();
      return;
    }
    setStep((current) => current - 1);
  };
  const goToStep = (target: number) => {
    if (connected || target >= step) return;
    setStep(target);
  };

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setFormError("");
    try {
      const accountId = isTelegram ? deriveTelegramAccountId(token) : "main";
      const next = await connect.mutateAsync({
        adapter: adapterId,
        accountId,
        config: { botToken: token.trim() },
      });
      if (next.ok) {
        setResult(next);
        setStep(STEP_ONLINE);
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

  const stepTitle =
    step === STEP_CREATE
      ? "Create your GSV messenger bot"
      : step === STEP_TOKEN
        ? "Generate an access token"
        : step === STEP_CONNECT
          ? "Insert your access token"
          : "Messenger-bot online!";

  return (
    <section class="gsv-connect">
      <div class="gsv-connect-shell">
        <ConsoleDetailHeader
          icon={iconForAdapterName(adapterId)}
          title="Connect messenger bot"
          typeLabel={`${name.toUpperCase()} · NEW MESSENGER`}
          statusLabel={connected ? "CONNECTED" : "NOT CONNECTED"}
          tone={connected ? "online" : "idle"}
        />

        <p class="gsv-console-detail-blurb">
          Link a {name} bot to your GSV so you can check files, approve tasks, and stay in control from anywhere.
        </p>

        <div class="gsv-connect-stepper" aria-label="Connection progress">
          <Stepper
            count={4}
            current={step}
            l0="CREATE BOT"
            l1="GET TOKEN"
            l2="CONNECT"
            l3="ONLINE"
            size="medium"
            width={520}
            onChange={goToStep}
          />
        </div>

        <div class="gsv-connect-step">
          <SectionHeader
            title={stepTitle}
            meta={onPlatform ? `IN ${name.toUpperCase()}` : "IN GSV"}
            divider
          />
          <div class="gsv-connect-step-body">
            {onPlatform ? (
              <Alert
                variant="attention"
                text={`Do this step in ${name} — finish it there, then come back to GSV to continue.`}
              />
            ) : null}

            {step === STEP_CREATE ? (
              <>
                <p class="gsv-connect-step-desc">
                  {isTelegram
                    ? "Open BotFather in Telegram and create a new bot to act as your GSV's messenger."
                    : "Create a new bot application in the Discord developer portal to act as your GSV's messenger."}
                </p>
                <div class="gsv-connect-step-links">
                  {isTelegram ? <Link href={BOTFATHER_URL}>Open BotFather</Link> : null}
                  <Link href={docUrl} arrow>Need help? Documentation</Link>
                </div>
              </>
            ) : step === STEP_TOKEN ? (
              <>
                <p class="gsv-connect-step-desc">
                  {isTelegram
                    ? "BotFather hands you an access token once the bot is created. Copy it — you'll paste it in the next step."
                    : "In your bot's settings, create a bot token and copy it — you'll paste it in the next step."}
                </p>
                <div class="gsv-connect-step-links">
                  <Link href={docUrl} arrow>Need help? Documentation</Link>
                </div>
              </>
            ) : step === STEP_CONNECT ? (
              <>
                <p class="gsv-connect-step-desc">
                  Paste the token below to connect your {name} bot to GSV.
                </p>
                <div class="gsv-connect-token-field">
                  <TextInput
                    label="ACCESS TOKEN"
                    size="large"
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
              </>
            ) : (
              <>
                <p class="gsv-connect-step-desc">
                  Your {name} bot is connected. Start messaging your GSV — open a chat and ask it to message your bot,
                  or message the bot directly.
                </p>
                <div class="gsv-connect-caps">
                  <SectionHeader title="THINGS YOU CAN DO" titleSize="section" divider />
                  <div class="gsv-connect-caps-rows">
                    {MESSENGER_CAPABILITIES.map((cap) => (
                      <ListRow key={cap.title} label={cap.title} sub={cap.detail} status="none" />
                    ))}
                  </div>
                </div>
                <div class="gsv-connect-step-links">
                  <Link href={docUrl} arrow>Read the docs</Link>
                </div>
                {result?.challenge ? (
                  <Alert
                    variant="warning"
                    text="This adapter returned an extra authentication step — open the bot detail to finish it."
                  />
                ) : null}
              </>
            )}
          </div>

          <div class="gsv-connect-actions">
            {step === STEP_ONLINE ? (
              <>
                <Button variant="secondary" label="VIEW BOT" onClick={goToDetail} />
                <Button variant="primary" label="DONE" onClick={onBack} />
              </>
            ) : step === STEP_CONNECT ? (
              <>
                <Button variant="secondary" label="BACK" disabled={connect.isPending} onClick={goBack} />
                <Button
                  variant="primary"
                  label={connect.isPending ? "CONNECTING" : "CONNECT"}
                  disabled={!canSubmit}
                  onClick={submit}
                />
              </>
            ) : (
              <>
                <Button variant="secondary" label={step === STEP_CREATE ? "CANCEL" : "BACK"} onClick={goBack} />
                <Button variant="primary" label="NEXT" onClick={goNext} />
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
