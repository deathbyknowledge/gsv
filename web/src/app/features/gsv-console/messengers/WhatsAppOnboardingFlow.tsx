import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Link } from "../../../components/ui/Link";
import { ListRow } from "../../../components/ui/ListRow";
import { TextInput } from "../../../components/ui/TextInput";
import { useUnsavedGuard, useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import type { ConnectConsoleAdapterResult, IdentityLinkMutationResult } from "../backend/consoleService";
import { ConnectFlowShell } from "../connect-flows/ConnectFlowShell";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import { useConsumeIdentityLinkCode } from "../hooks/useConsoleData";
import { MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import {
  adapterDetailId,
  adapterName,
  iconForAdapterName,
  messengerIdentityLabel,
  whatsappAccountIdLabel,
} from "./messengerPresentation";
import { useWhatsAppPairing } from "./useWhatsAppPairing";
import { WhatsAppQrCode } from "./WhatsAppQrCode";
import {
  initialWhatsAppAccountId,
  whatsappAccountIdError,
} from "./whatsappPairing";
import "./WhatsAppPairing.css";

type WhatsAppOnboardingFlowProps = {
  existingAccountIds?: readonly string[];
  forceRelink?: boolean;
  initialAccountId?: string | null;
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

type SuccessfulConnectResult = Extract<ConnectConsoleAdapterResult, { ok: true }>;

const STEP_PREPARE = 0;
const STEP_PAIR = 1;
const STEP_LINK = 2;
const stepLinksStyle = { display: "flex", flexWrap: "wrap" as const, gap: "18px", alignItems: "center" };
const fieldStyle = { maxWidth: "520px" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "";
}

function linkedText(result: IdentityLinkMutationResult): string {
  return result.link
    ? `${adapterName(result.link.adapter)} / ${messengerIdentityLabel(
      result.link.adapter,
      result.link.actorId,
    )}`
    : "Messenger identity";
}

function resultDetailId(result: SuccessfulConnectResult): string {
  return adapterDetailId({
    adapter: result.adapter,
    accountId: result.accountId,
    connected: result.connected,
    authenticated: result.authenticated,
    mode: "",
    lastActivity: null,
    error: "",
    extra: {},
  });
}

export function WhatsAppOnboardingFlow({
  existingAccountIds = [],
  forceRelink = false,
  initialAccountId = null,
  onBack,
  onConnected,
}: WhatsAppOnboardingFlowProps): JSX.Element {
  const [initialId] = useState(
    () => initialWhatsAppAccountId(initialAccountId, existingAccountIds),
  );
  const accountIdLocked = Boolean(initialAccountId?.trim());
  const reconnecting = accountIdLocked && !forceRelink;
  const consumeLinkCode = useConsumeIdentityLinkCode();
  const [step, setStep] = useState(STEP_PREPARE);
  const [accountId, setAccountId] = useState(initialId);
  const [qrRenderError, setQrRenderError] = useState(false);
  const [linkCode, setLinkCode] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkResultText, setLinkResultText] = useState("");
  const requestLeave = useUnsavedGuardLeave();
  const normalizedAccountId = accountId.trim();
  const accountError = whatsappAccountIdError(
    accountId,
    accountIdLocked ? [] : existingAccountIds,
  );
  const linked = linkResultText.length > 0;
  const pairing = useWhatsAppPairing({
    accountId,
    forceRelink,
    pairScreenActive: step === STEP_PAIR,
    reconnectExisting: reconnecting,
  });
  const {
    error: formError,
    isPending: pairingPending,
    liveAccount,
    paired,
    pairedPhone,
    pairingStarted,
    qrSource,
    result,
    secondsRemaining,
  } = pairing;
  const pairedAccountLabel = pairedPhone
    || whatsappAccountIdLabel(normalizedAccountId);

  useUnsavedGuard(
    () => !linked && (pairingStarted || accountId !== initialId || linkCode.trim() !== ""),
  );

  const pair = async () => {
    setQrRenderError(false);
    const outcome = await pairing.pair();
    if (outcome !== "superseded") {
      setStep(outcome === "paired" ? STEP_LINK : STEP_PAIR);
    }
  };

  useEffect(() => {
    if (pairingStarted && paired) {
      setStep(STEP_LINK);
    }
  }, [paired, pairingStarted]);

  useEffect(() => {
    setQrRenderError(false);
  }, [qrSource?.kind, qrSource?.value]);

  useEffect(() => {
    setQrRenderError(false);
    setLinkCode("");
    setLinkError("");
    setLinkResultText("");
  }, [normalizedAccountId]);

  const submitLinkCode = async () => {
    if (!paired || !linkCode.trim() || consumeLinkCode.isPending) {
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

  const goBack = () => {
    if (step === STEP_PREPARE) {
      requestLeave(onBack);
      return;
    }
    setStep((current) => current - 1);
  };
  const goToStep = (target: number) => {
    if (linked || target >= step) {
      return;
    }
    setStep(target);
  };
  const openDetail = () => {
    if (result) {
      onConnected(resultDetailId(result));
    } else if (liveAccount) {
      onConnected(adapterDetailId(liveAccount));
    } else {
      onBack();
    }
  };
  const handleQrRenderError = useCallback(() => {
    setQrRenderError(true);
  }, []);

  const status = linked
    ? "LINKED"
    : paired
      ? "PAIRED"
      : pairingStarted
        ? "WAITING FOR SCAN"
        : "NOT PAIRED";
  const tone = paired ? "online" as const : pairingStarted ? "warn" as const : "idle" as const;
  const flow: ConnectFlowDef = {
    key: "whatsapp",
    navLabel: "WHATSAPP",
    parentLabel: "MESSENGERS",
    icon: iconForAdapterName("whatsapp"),
    title: forceRelink
      ? "Relink WhatsApp account"
      : reconnecting
        ? "Reconnect WhatsApp account"
        : "Pair WhatsApp account",
    blurb: "Link a dedicated WhatsApp account so you can securely message your GSV from anywhere · WhatsApp linked device.",
    steps: [
      {
        key: "prepare",
        label: "PREPARE",
        title: "Prepare your WhatsApp account",
        meta: "IN GSV",
        status,
        tone,
        render: () => (
          <>
            <Alert
              variant="attention"
              title="SECOND NUMBER REQUIRED"
              text="You need a second WhatsApp number, but not necessarily a second phone."
            />
            <p class="gsv-cf-desc">
              WhatsApp can keep two accounts on one compatible phone. Setup still requires a second number through
              another SIM, multi-SIM, or eSIM.
            </p>
            <ul class="gsv-whatsapp-requirements gsv-prose-sm">
              <li>Keep your personal WhatsApp account separate from the account GSV will use.</li>
              <li>The GSV account must be able to receive the one-time registration code from WhatsApp.</li>
              <li>After registration, GSV connects as a linked device by scanning the QR code in the next step.</li>
            </ul>
            {forceRelink ? (
              <Alert
                variant="warning"
                title="FRESH LINK REQUESTED"
                text="Starting this pairing clears the existing linked-device credentials for this GSV account."
              />
            ) : null}
            <div style={fieldStyle}>
              <TextInput
                label="LOCAL ACCOUNT ID"
                description={accountIdLocked
                  ? "Reconnect and relink operations preserve this account ID."
                  : "A stable local label for this WhatsApp account. This is not the phone number."}
                requirement="required"
                value={accountId}
                placeholder="default"
                disabled={pairingPending}
                readonly={accountIdLocked}
                clearable={!accountIdLocked}
                status={accountError ? "error" : "none"}
                message={accountError}
                onChange={setAccountId}
                inputProps={{ name: "whatsappAccountId", autoComplete: "off" }}
              />
            </div>
            <div style={stepLinksStyle}>
              <Link href={adapterDocUrl("whatsapp")} arrow>Need help? Documentation</Link>
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" disabled={pairingPending} onClick={goBack} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={pairingPending
                  ? "STARTING"
                  : forceRelink
                    ? "START FRESH PAIRING"
                    : reconnecting
                      ? "RECONNECT"
                      : "GENERATE QR CODE"}
                disabled={Boolean(accountError) || pairingPending}
                onClick={() => void pair()}
              />
            </div>
          </>
        ),
      },
      {
        key: "pair",
        label: "SCAN QR",
        title: "Link GSV in WhatsApp",
        meta: "IN WHATSAPP",
        status,
        tone,
        render: () => (
          <>
            <Alert
              variant={paired ? "success" : formError || qrRenderError ? "error" : "attention"}
              title={paired ? "ACCOUNT PAIRED" : formError || qrRenderError ? "QR CODE NEEDS ATTENTION" : "SCAN IN LINKED DEVICES"}
              text={paired
                ? `${pairedAccountLabel} is connected to GSV.`
                : formError || (qrRenderError ? "GSV could not render this QR code safely. Refresh it to try again." : "Keep this page open while you scan. GSV will continue automatically when WhatsApp confirms the link.")}
            />
            {qrSource && !paired ? (
              <div class="gsv-whatsapp-pairing-grid">
                <WhatsAppQrCode source={qrSource} onRenderError={handleQrRenderError} />
                <div class="gsv-whatsapp-pairing-instructions gsv-prose-sm">
                  <ol>
                    <li>Open WhatsApp on the phone holding the second account.</li>
                    <li>Open Settings or the menu, then choose Linked Devices.</li>
                    <li>Choose Link a device and scan this QR code.</li>
                  </ol>
                  <div class="gsv-whatsapp-pairing-meta gsv-sublabel">
                    {secondsRemaining > 0
                      ? `QR REFRESHES IN ${secondsRemaining}S`
                      : pairingPending
                        ? "REFRESHING QR CODE"
                        : "QR CODE EXPIRED"}
                  </div>
                  <p class="gsv-cf-desc">
                    If the code expires before you scan it, GSV refreshes it automatically.
                  </p>
                </div>
              </div>
            ) : null}
            {!qrSource && !paired && !formError ? (
              <div class="gsv-cf-cap">
                <div class="gsv-cf-cap-text">
                  <span class="gsv-cf-cap-title">WAITING FOR QR CODE</span>
                  <span class="gsv-cf-cap-sub">The WhatsApp adapter is preparing a linked-device session.</span>
                </div>
              </div>
            ) : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" disabled={pairingPending} onClick={goBack} />
              <span class="gsv-cf-footer-spacer" />
              {!paired ? (
                <Button
                  variant="primary"
                  label={pairingPending ? "REFRESHING" : "REFRESH QR"}
                  disabled={pairingPending}
                  onClick={() => void pair()}
                />
              ) : (
                <Button variant="primary" label="CONTINUE" onClick={() => setStep(STEP_LINK)} />
              )}
            </div>
          </>
        ),
      },
      {
        key: "link",
        label: "LINK USER",
        title: "Link your GSV user",
        meta: "FINALIZE",
        status,
        tone,
        render: () => (
          <>
            <p class="gsv-cf-desc">
              From your personal WhatsApp account, message {pairedPhone || "the WhatsApp number paired above"}.
              Enter the authorization code it sends back so GSV can recognize you.
            </p>
            <Alert
              variant={linked ? "success" : "attention"}
              title={linked ? "USER LINKED" : "MESSAGE THE GSV WHATSAPP ACCOUNT"}
              text={linked
                ? `${linkResultText} can now authenticate with this GSV.`
                : "Send any message, wait for the link-code response, then enter that code here."}
            />
            {!linked ? (
              <div style={fieldStyle}>
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
            ) : (
              <>
                <div class="gsv-cf-framed">
                  {MESSENGER_CAPABILITIES.map((capability) => (
                    <ListRow key={capability.title} label={capability.title} sub={capability.detail} status="none" />
                  ))}
                </div>
                <div style={stepLinksStyle}>
                  <Link href={adapterDocUrl("whatsapp")} arrow>Read the docs</Link>
                </div>
              </>
            )}
            <div class="gsv-cf-footer">
              <Button
                variant="secondary"
                label="VIEW ACCOUNT"
                disabled={consumeLinkCode.isPending}
                onClick={openDetail}
              />
              <span class="gsv-cf-footer-spacer" />
              {linked ? (
                <Button variant="primary" label="DONE" onClick={onBack} />
              ) : (
                <Button
                  variant="primary"
                  label={consumeLinkCode.isPending ? "LINKING" : "LINK USER"}
                  disabled={!paired || !linkCode.trim() || consumeLinkCode.isPending}
                  onClick={() => void submitLinkCode()}
                />
              )}
            </div>
          </>
        ),
      },
    ],
  };

  return <ConnectFlowShell flow={flow} current={step} onStep={goToStep} />;
}
