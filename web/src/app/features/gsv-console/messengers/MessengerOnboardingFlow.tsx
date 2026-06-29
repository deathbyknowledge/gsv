import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Link } from "../../../components/ui/Link";
import { ListRow } from "../../../components/ui/ListRow";
import { TextInput } from "../../../components/ui/TextInput";
import { ConnectFlowShell } from "../connect-flows/ConnectFlowShell";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import type { ConnectConsoleAdapterResult, IdentityLinkMutationResult } from "../backend/consoleService";
import { useConnectConsoleAdapter, useConsumeIdentityLinkCode } from "../hooks/useConsoleData";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import { BOTFATHER_URL, DISCORD_DEVELOPER_URL, MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import { adapterDetailId, adapterName, deriveAccountId, iconForAdapterName } from "./messengerPresentation";

type MessengerOnboardingFlowProps = {
  adapterId: string;
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

/** Step indices for the progressive-disclosure wizard. */
const STEP_CREATE = 0;
const STEP_TOKEN = 1;
const STEP_CONNECT = 2;
const STEP_LINK = 3;

const stepLinksStyle = { display: "flex", flexWrap: "wrap" as const, gap: "18px", alignItems: "center" };
const tokenFieldStyle = { maxWidth: "520px" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function linkedText(result: IdentityLinkMutationResult): string {
  return result.link
    ? `${adapterName(result.link.adapter)} / ${result.link.actorId}`
    : "Messenger identity";
}

export function MessengerOnboardingFlow({
  adapterId,
  onBack,
  onConnected,
}: MessengerOnboardingFlowProps): JSX.Element {
  const connect = useConnectConsoleAdapter();
  const consumeLinkCode = useConsumeIdentityLinkCode();
  const [step, setStep] = useState(STEP_CREATE);
  const [token, setToken] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [result, setResult] = useState<ConnectConsoleAdapterResult | null>(null);
  const [formError, setFormError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkResultText, setLinkResultText] = useState("");

  useUnsavedGuard(
    () => !linked && (step > STEP_CREATE || token.trim() !== "" || linkCode.trim() !== ""),
  );

  const isTelegram = adapterId === "telegram";
  const name = adapterName(adapterId);
  const docUrl = adapterDocUrl(adapterId);
  const botConnected = Boolean(result?.ok && result?.connected && result?.authenticated);
  const linked = linkResultText.length > 0;
  const canSubmit = token.trim().length > 0 && !connect.isPending;
  const canLinkUser = botConnected && linkCode.trim().length > 0 && !consumeLinkCode.isPending;
  // Steps 1-2 are performed on the messaging platform; 3-4 happen inside GSV.
  const onPlatform = step <= STEP_TOKEN;

  const requestLeave = useUnsavedGuardLeave();
  const goNext = () => setStep((current) => Math.min(current + 1, STEP_CONNECT));
  const goBack = () => {
    if (step === STEP_CREATE) {
      // Leaving the flow entirely — guard so a typed token/link code prompts
      // before discarding. (Stepping back between steps keeps that state.)
      requestLeave(onBack);
      return;
    }
    setStep((current) => current - 1);
  };
  const goToStep = (target: number) => {
    if (linked || target >= step) return;
    setStep(target);
  };

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setFormError("");
    try {
      const accountId = deriveAccountId(adapterId, token.trim());
      const next = await connect.mutateAsync({
        adapter: adapterId,
        accountId,
        config: { botToken: token.trim() },
      });
      if (next.ok && next.connected && next.authenticated) {
        setResult(next);
        setLinkCode("");
        setLinkError("");
        setLinkResultText("");
        setStep(STEP_LINK);
        return;
      }
      if (next.ok) {
        // The adapter accepted the token but the bot isn't online/authenticated
        // yet — e.g. the Discord gateway opened before READY, or the token is
        // invalid/revoked. Don't advance and claim a false success.
        setResult(next);
        setFormError(
          next.challenge?.message ||
            "The bot connected but isn't authenticated yet. Check the token is valid, then try again.",
        );
        return;
      }
      setFormError(next.error || next.message);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const submitLinkCode = async () => {
    if (!canLinkUser) {
      return;
    }
    setLinkError("");
    setLinkResultText("");
    try {
      const next = await consumeLinkCode.mutateAsync({ code: linkCode });
      setLinkCode("");
      setLinkResultText(linkedText(next));
    } catch (error) {
      setLinkError(errorText(error));
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

  const status = linked ? "LINKED" : botConnected ? "CONNECTED" : "NOT CONNECTED";
  const stepMeta = (index: number) =>
    index === STEP_LINK ? "FINALIZE" : index <= STEP_TOKEN ? `IN ${name.toUpperCase()}` : "IN GSV";
  const platformAlert = onPlatform ? (
    <Alert
      variant="attention"
      text={`Do this step in ${name} — finish it there, then come back to GSV to continue.`}
    />
  ) : null;

  const flow: ConnectFlowDef = {
    key: "messengers",
    navLabel: "MESSENGER",
    parentLabel: "MESSENGERS",
    icon: iconForAdapterName(adapterId),
    title: `Connect ${name} bot`,
    blurb: `Link a ${name} bot so you can check files and approve tasks from anywhere · ${name} messenger.`,
    steps: [
      {
        key: "create",
        label: "CREATE BOT",
        title: "Create your GSV messenger bot",
        meta: stepMeta(STEP_CREATE),
        status,
        tone: botConnected ? "online" : "idle",
        render: () => (
          <>
            {platformAlert}
            <p class="gsv-cf-desc">
              {isTelegram
                ? "Open BotFather in Telegram and create a new bot to act as your GSV's messenger."
                : "Create a new bot application in the Discord developer portal to act as your GSV's messenger."}
            </p>
            <div style={stepLinksStyle}>
              <Link href={isTelegram ? BOTFATHER_URL : DISCORD_DEVELOPER_URL}>
                {isTelegram ? "Open BotFather" : "Open Discord Developer Portal"}
              </Link>
              <Link href={docUrl} arrow>Need help? Documentation</Link>
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="CANCEL" onClick={goBack} />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label="NEXT" onClick={goNext} />
            </div>
          </>
        ),
      },
      {
        key: "token",
        label: "GET TOKEN",
        title: "Generate an access token",
        meta: stepMeta(STEP_TOKEN),
        status,
        tone: botConnected ? "online" : "idle",
        render: () => (
          <>
            {platformAlert}
            <p class="gsv-cf-desc">
              {isTelegram
                ? "BotFather hands you an access token once the bot is created. Copy it — you'll paste it in the next step."
                : "In your bot's settings, create a bot token and copy it — you'll paste it in the next step."}
            </p>
            <div style={stepLinksStyle}>
              <Link href={docUrl} arrow>Need help? Documentation</Link>
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={goBack} />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label="NEXT" onClick={goNext} />
            </div>
          </>
        ),
      },
      {
        key: "connect",
        label: "CONNECT",
        title: "Insert your access token",
        meta: stepMeta(STEP_CONNECT),
        status,
        tone: botConnected ? "online" : "idle",
        render: () => (
          <>
            {platformAlert}
            <p class="gsv-cf-desc">
              Paste the token below to connect your {name} bot to GSV.
            </p>
            <div style={tokenFieldStyle}>
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
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" disabled={connect.isPending} onClick={goBack} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={connect.isPending ? "CONNECTING" : "CONNECT"}
                disabled={!canSubmit}
                onClick={submit}
              />
            </div>
          </>
        ),
      },
      {
        key: "link",
        label: "LINK USER",
        title: "Link your GSV user",
        meta: stepMeta(STEP_LINK),
        status,
        tone: botConnected ? "online" : "idle",
        render: () => (
          <>
            <p class="gsv-cf-desc">
              Your {name} bot account has been created. Message the bot from the user account you want to link,
              then paste the authorization code it sends back.
            </p>
            <Alert
              variant={linked ? "success" : "attention"}
              title={linked ? "USER LINKED" : `MESSAGE YOUR ${name.toUpperCase()} BOT`}
              text={linked
                ? `${linkResultText} can now authenticate with this GSV.`
                : "Send the bot a message, wait for its link code response, and enter that code here to finish setup."}
            />
            {!linked ? (
              <div style={tokenFieldStyle}>
                <TextInput
                  label="AUTHORIZATION CODE"
                  size="large"
                  requirement="required"
                  value={linkCode}
                  placeholder="ABC123"
                  clearable
                  status={linkError ? "error" : "none"}
                  message={linkError}
                  onChange={(value) => {
                    if (linkError) setLinkError("");
                    setLinkCode(value);
                  }}
                  inputProps={{
                    autoComplete: "one-time-code",
                    name: "messengerIdentityLinkCode",
                    onKeyDown: (event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitLinkCode();
                      }
                    },
                  }}
                />
              </div>
            ) : null}
            {linked ? (
              <>
                <div class="gsv-cf-framed">
                  {MESSENGER_CAPABILITIES.map((cap) => (
                    <ListRow key={cap.title} label={cap.title} sub={cap.detail} status="none" />
                  ))}
                </div>
                <div style={stepLinksStyle}>
                  <Link href={docUrl} arrow>Read the docs</Link>
                </div>
                {result?.challenge ? (
                  <Alert
                    variant="warning"
                    text="This adapter returned an extra authentication step — open the bot detail to finish it."
                  />
                ) : null}
              </>
            ) : null}
            {step === STEP_LINK && linked ? (
              <div class="gsv-cf-footer">
                <Button variant="secondary" label="VIEW BOT" onClick={goToDetail} />
                <span class="gsv-cf-footer-spacer" />
                <Button variant="primary" label="DONE" onClick={onBack} />
              </div>
            ) : (
              <div class="gsv-cf-footer">
                <Button variant="secondary" label="BACK" disabled={consumeLinkCode.isPending} onClick={goBack} />
                <span class="gsv-cf-footer-spacer" />
                <Button
                  variant="primary"
                  label={consumeLinkCode.isPending ? "LINKING" : "LINK USER"}
                  disabled={!canLinkUser}
                  onClick={submitLinkCode}
                />
              </div>
            )}
          </>
        ),
      },
    ],
  };

  return <ConnectFlowShell flow={flow} current={step} onStep={goToStep} />;
}
