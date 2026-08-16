import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Link } from "../../../components/ui/Link";
import { ListRow } from "../../../components/ui/ListRow";
import { TextInput } from "../../../components/ui/TextInput";
import { useUnsavedGuard } from "../../gsv-shell/unsaved/unsavedGuard";
import { ConnectFlowShell } from "../connect-flows/ConnectFlowShell";
import type { ConnectFlowDef } from "../connect-flows/connectFlowTypes";
import type { ConsoleAdapterPairingCandidate } from "../backend/consoleService";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useInspectConsoleAdapterPairing,
} from "../hooks/useConsoleData";
import { MESSENGER_CAPABILITIES } from "./messengerDocs";
import { adapterDetailId } from "./messengerPresentation";

type ManagedTelegramOnboardingFlowProps = {
  onBack: () => void;
  onConnected: (detailId: string) => void;
};

const STEP_MESSAGE = 0;
const STEP_CODE = 1;
const STEP_CONFIRM = 2;
const STEP_DONE = 3;
const fieldStyle = { maxWidth: "520px" };

export function ManagedTelegramOnboardingFlow({
  onBack,
  onConnected,
}: ManagedTelegramOnboardingFlowProps): JSX.Element {
  const info = useConsoleAdapterPairingInfo("telegram");
  const inspect = useInspectConsoleAdapterPairing();
  const confirm = useConfirmConsoleAdapterPairing();
  const [step, setStep] = useState(STEP_MESSAGE);
  const [code, setCode] = useState("");
  const [candidate, setCandidate] = useState<ConsoleAdapterPairingCandidate | null>(null);
  const [formError, setFormError] = useState("");
  const paired = step === STEP_DONE;
  useUnsavedGuard(() => !paired && (step > STEP_MESSAGE || code.trim().length > 0));

  const botUsername = info.data?.botUsername?.replace(/^@/, "") ?? "";
  const botUrl = botUsername ? `https://t.me/${botUsername}` : "https://telegram.org/";
  const displayIdentity = candidate?.actorHandle
    || candidate?.actorName
    || (candidate ? `Telegram user ${candidate.actorId}` : "Telegram identity");

  const inspectCode = async () => {
    if (!code.trim() || inspect.isPending) return;
    setFormError("");
    try {
      const next = await inspect.mutateAsync({ adapter: "telegram", code });
      setCandidate(next);
      setStep(STEP_CONFIRM);
    } catch (error) {
      setCandidate(null);
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmIdentity = async () => {
    if (!candidate || confirm.isPending) return;
    setFormError("");
    try {
      await confirm.mutateAsync({ adapter: "telegram", code });
      setStep(STEP_DONE);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const detailId = adapterDetailId({
    adapter: "telegram",
    accountId: info.data?.accountId ?? "managed",
    connected: true,
    authenticated: true,
    mode: "managed-shared",
    lastActivity: null,
    error: "",
    extra: botUsername ? { botUsername } : {},
  });

  const flow: ConnectFlowDef = {
    key: "managed-telegram",
    navLabel: "TELEGRAM",
    parentLabel: "MESSENGERS",
    icon: "telegram",
    title: "Connect Telegram",
    blurb: "Message the official GSV bot, then confirm that Telegram identity here.",
    steps: [
      {
        key: "message",
        label: "MESSAGE GSV",
        title: "Message the GSV bot",
        meta: "IN TELEGRAM",
        status: paired ? "CONNECTED" : "NOT CONNECTED",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant="attention"
              title="START IN TELEGRAM"
              text="Send the official GSV bot any private message. It will reply with a short-lived pairing code."
            />
            {info.isError ? (
              <Alert variant="error" text={info.error.message} />
            ) : !info.data?.configured ? (
              <Alert variant="warning" text="Managed Telegram is not configured for this GSV environment yet." />
            ) : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={onBack} />
              <span class="gsv-cf-footer-spacer" />
              <Link href={botUrl}>{botUsername ? `OPEN @${botUsername}` : "OPEN TELEGRAM"}</Link>
              <Button
                variant="primary"
                label="I HAVE A CODE"
                disabled={!info.data?.configured}
                onClick={() => setStep(STEP_CODE)}
              />
            </div>
          </>
        ),
      },
      {
        key: "code",
        label: "ENTER CODE",
        title: "Enter the code from Telegram",
        meta: "IN GSV",
        status: paired ? "CONNECTED" : "PAIRING",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <p class="gsv-cf-desc">
              Codes expire after 10 minutes. Entering one only reveals the Telegram identity;
              nothing is linked until you confirm it on the next step.
            </p>
            <div style={fieldStyle}>
              <TextInput
                label="PAIRING CODE"
                size="large"
                requirement="required"
                value={code}
                placeholder="ABCD-EFGH-JKLM"
                clearable
                status={formError ? "error" : "none"}
                message={formError}
                onChange={(value) => {
                  setCode(value.toUpperCase());
                  if (formError) setFormError("");
                }}
                inputProps={{
                  autoComplete: "one-time-code",
                  name: "managedTelegramPairingCode",
                  onKeyDown: (event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void inspectCode();
                    }
                  },
                }}
              />
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={() => setStep(STEP_MESSAGE)} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={inspect.isPending ? "CHECKING" : "CHECK CODE"}
                disabled={!code.trim() || inspect.isPending}
                onClick={() => void inspectCode()}
              />
            </div>
          </>
        ),
      },
      {
        key: "confirm",
        label: "CONFIRM",
        title: "Confirm your Telegram identity",
        meta: "IN GSV",
        status: paired ? "CONNECTED" : "CONFIRM IDENTITY",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant={candidate?.linked ? "warning" : "attention"}
              title={candidate?.linked ? "MOVE THIS TELEGRAM IDENTITY?" : "IS THIS YOU?"}
              text={candidate?.linked
                ? `${displayIdentity} is linked to another GSV. Confirming moves future messages here; the old link stays active until this confirmation succeeds.`
                : `Telegram reported ${displayIdentity}. Confirm only if this is the account that messaged the bot.`}
            />
            <div class="gsv-cf-framed">
              <ListRow
                label={displayIdentity}
                sub={candidate ? `Telegram ID ${candidate.actorId}` : "No identity loaded"}
                status="none"
              />
            </div>
            {formError ? <Alert variant="error" text={formError} /> : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={() => setStep(STEP_CODE)} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={confirm.isPending ? "CONNECTING" : "YES, CONNECT THIS IDENTITY"}
                disabled={!candidate || confirm.isPending}
                onClick={() => void confirmIdentity()}
              />
            </div>
          </>
        ),
      },
      {
        key: "done",
        label: "DONE",
        title: "Telegram is connected",
        meta: "READY",
        status: "CONNECTED",
        tone: "online",
        render: () => (
          <>
            <Alert
              variant="success"
              title="CONNECTED"
              text={`${displayIdentity} now reaches your personal intelligence. You can move between GSV and Telegram without choosing another agent.`}
            />
            <div class="gsv-cf-framed">
              {MESSENGER_CAPABILITIES.map((cap) => (
                <ListRow key={cap.title} label={cap.title} sub={cap.detail} status="none" />
              ))}
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="VIEW TELEGRAM" onClick={() => onConnected(detailId)} />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label="DONE" onClick={onBack} />
            </div>
          </>
        ),
      },
    ],
  };

  return <ConnectFlowShell flow={flow} current={step} onStep={(next) => {
    if (next <= step || paired) setStep(next);
  }} />;
}
