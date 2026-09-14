import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { Alert } from "../../../../components/ui/Alert";
import { Button } from "../../../../components/ui/Button";
import { Link } from "../../../../components/ui/Link";
import { ListRow } from "../../../../components/ui/ListRow";
import { TextInput } from "../../../../components/ui/TextInput";
import { useUnsavedGuard } from "../../../../services/navigation/unsavedGuard";
import { ConnectFlowShell } from "../../../../components/connect-flow/ConnectFlowShell";
import type { ConnectFlowDef } from "../../../../components/connect-flow/connectFlowTypes";
import type { ConsoleAdapterPairingCandidate } from "../../../../services/system/consoleService";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useInspectConsoleAdapterPairing,
} from "../../../../services/system/useConsoleData";
import { MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import { adapterDetailId } from "./messengerPresentation";

type ManagedTelegramOnboardingFlowProps = {
  onBack: () => void;
  onConnected: (detailId: string) => void;
  dependencies?: ManagedTelegramDependencies;
};

type ManagedMessengerOnboardingFlowProps = Omit<ManagedTelegramOnboardingFlowProps, "dependencies"> & {
  adapterId: "telegram" | "slack" | "discord";
  dependencies: ManagedTelegramDependencies;
};

export type ManagedTelegramDependencies = {
  ConnectFlowShell: (props: Parameters<typeof ConnectFlowShell>[0]) => ComponentChildren;
  useUnsavedGuard: typeof useUnsavedGuard;
  useConsoleAdapterPairingInfo: (adapter: string) => Pick<ReturnType<typeof useConsoleAdapterPairingInfo>, "data" | "isError" | "error">;
  useInspectConsoleAdapterPairing: () => Pick<ReturnType<typeof useInspectConsoleAdapterPairing>, "isPending" | "mutateAsync">;
  useConfirmConsoleAdapterPairing: () => Pick<ReturnType<typeof useConfirmConsoleAdapterPairing>, "isPending" | "mutateAsync">;
};

const defaultDependencies: ManagedTelegramDependencies = {
  ConnectFlowShell: (props) => <ConnectFlowShell {...props} />,
  useUnsavedGuard: (...args) => useUnsavedGuard(...args),
  useConsoleAdapterPairingInfo: (...args) => useConsoleAdapterPairingInfo(...args),
  useInspectConsoleAdapterPairing: () => useInspectConsoleAdapterPairing(),
  useConfirmConsoleAdapterPairing: () => useConfirmConsoleAdapterPairing(),
};

const STEP_MESSAGE = 0;
const STEP_CODE = 1;
const STEP_CONFIRM = 2;
const STEP_DONE = 3;
const fieldStyle = { maxWidth: "520px" };

export function ManagedTelegramOnboardingFlow({
  onBack,
  onConnected,
  dependencies = defaultDependencies,
}: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return (
    <ManagedMessengerOnboardingFlow
      adapterId="telegram"
      onBack={onBack}
      onConnected={onConnected}
      dependencies={dependencies}
    />
  );
}

export function ManagedSlackOnboardingFlow({
  onBack,
  onConnected,
  dependencies = defaultDependencies,
}: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return (
    <ManagedMessengerOnboardingFlow
      adapterId="slack"
      onBack={onBack}
      onConnected={onConnected}
      dependencies={dependencies}
    />
  );
}

export function SharedDiscordOnboardingFlow({ onBack, onConnected, dependencies = defaultDependencies }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="discord" onBack={onBack} onConnected={onConnected} dependencies={dependencies} />;
}

function ManagedMessengerOnboardingFlow({
  adapterId,
  onBack,
  onConnected,
  dependencies,
}: ManagedMessengerOnboardingFlowProps): JSX.Element {
  const info = dependencies.useConsoleAdapterPairingInfo(adapterId);
  const inspect = dependencies.useInspectConsoleAdapterPairing();
  const confirm = dependencies.useConfirmConsoleAdapterPairing();
  const [step, setStep] = useState(STEP_MESSAGE);
  const [code, setCode] = useState("");
  const [candidate, setCandidate] = useState<ConsoleAdapterPairingCandidate | null>(null);
  const [formError, setFormError] = useState("");
  const paired = step === STEP_DONE;
  dependencies.useUnsavedGuard(() => !paired && (step > STEP_MESSAGE || code.trim().length > 0));

  const isSlack = adapterId === "slack";
  const isDiscord = adapterId === "discord";
  const installsApp = isSlack || isDiscord;
  const platform = isSlack ? "Slack" : isDiscord ? "Discord" : "Telegram";
  const botUsername = info.data?.botUsername?.replace(/^@/, "") ?? "";
  const launchUrl = installsApp
    ? info.data?.installUrl ?? adapterDocUrl(adapterId)
    : botUsername ? `https://t.me/${botUsername}` : "https://telegram.org/";
  const displayIdentity = candidate?.actorHandle
    || candidate?.actorName
    || (candidate ? `${platform} user ${candidate.actorId}` : `${platform} identity`);

  const inspectCode = async () => {
    if (!code.trim() || inspect.isPending) return;
    setFormError("");
    try {
      const next = await inspect.mutateAsync({ adapter: adapterId, code });
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
      await confirm.mutateAsync({ adapter: adapterId, code });
      setStep(STEP_DONE);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const detailId = adapterDetailId({
    adapter: adapterId,
    accountId: candidate?.accountId ?? info.data?.accountId ?? "managed",
    connected: true,
    authenticated: true,
    mode: "managed-shared",
    lastActivity: null,
    error: "",
    extra: !installsApp && botUsername ? { botUsername } : {},
  });

  const flow: ConnectFlowDef = {
    key: `managed-${adapterId}`,
    navLabel: platform.toUpperCase(),
    parentLabel: "MESSENGERS",
    icon: installsApp ? "chat" : "telegram",
    title: `Connect ${platform}`,
    blurb: installsApp
      ? `Install the GSV app, mention it in ${platform}, then confirm your identity here.`
      : "Message the official GSV bot, then confirm that Telegram identity here.",
    steps: [
      {
        key: "message",
        label: installsApp ? "INSTALL & MENTION" : "MESSAGE GSV",
        title: installsApp ? "Install and mention GSV" : "Message the GSV bot",
        meta: `IN ${platform.toUpperCase()}`,
        status: paired ? "CONNECTED" : "NOT CONNECTED",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant="attention"
              title={`START IN ${platform.toUpperCase()}`}
              text={installsApp
                ? `Install the GSV app in your ${isDiscord ? "server" : "workspace"}, then mention @GSV in a channel or message it directly. GSV sends you a short-lived pairing code by DM.`
                : "Send the official GSV bot any private message. It will reply with a short-lived pairing code."}
            />
            {info.isError ? (
              <Alert variant="error" text={info.error?.message ?? `Unable to load ${platform} pairing details.`} />
            ) : !info.data?.configured ? (
              <Alert variant="warning" text={`${platform} linking is not configured for this GSV yet.`} />
            ) : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label="BACK" onClick={onBack} />
              <span class="gsv-cf-footer-spacer" />
              <Link href={launchUrl}>{installsApp
                ? info.data?.installUrl ? `INSTALL GSV IN ${platform.toUpperCase()}` : `VIEW ${platform.toUpperCase()} SETUP`
                : botUsername ? `OPEN @${botUsername}` : "OPEN TELEGRAM"}</Link>
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
        title: `Enter the code from ${platform}`,
        meta: "IN GSV",
        status: paired ? "CONNECTED" : "PAIRING",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <p class="gsv-cf-desc">
              Codes expire after 10 minutes. Entering one only reveals the {platform} identity;
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
                  name: `managed${platform}PairingCode`,
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
        title: `Confirm your ${platform} identity`,
        meta: "IN GSV",
        status: paired ? "CONNECTED" : "CONFIRM IDENTITY",
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant={candidate?.linked ? "warning" : "attention"}
              title={candidate?.linked ? `MOVE THIS ${platform.toUpperCase()} IDENTITY?` : "IS THIS YOU?"}
              text={candidate?.linked
                ? `${displayIdentity} is linked to another GSV. Confirming moves future messages here; the old link stays active until this confirmation succeeds.`
                : `${platform} reported ${displayIdentity}. Confirm only if this is the account that contacted GSV.`}
            />
            <div class="gsv-cf-framed">
              <ListRow
                label={displayIdentity}
                sub={candidate ? `${platform} ID ${candidate.actorId}${isDiscord ? ` · ${candidate.accountId}` : ""}` : "No identity loaded"}
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
        title: `${platform} is connected`,
        meta: "READY",
        status: "CONNECTED",
        tone: "online",
        render: () => (
          <>
            <Alert
              variant="success"
              title="CONNECTED"
              text={`${displayIdentity} now reaches your personal intelligence. You can move between GSV and ${platform} without choosing another agent.`}
            />
            <div class="gsv-cf-framed">
              {MESSENGER_CAPABILITIES.map((cap) => (
                <ListRow key={cap.title} label={cap.title} sub={cap.detail} status="none" />
              ))}
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label={`VIEW ${platform.toUpperCase()}`} onClick={() => onConnected(detailId)} />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label="DONE" onClick={onBack} />
            </div>
          </>
        ),
      },
    ],
  };

  const FlowShell = dependencies.ConnectFlowShell;
  return <FlowShell flow={flow} current={step} onStep={(next) => {
    if (next <= step || paired) setStep(next);
  }} />;
}
