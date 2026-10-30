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
import { useT, type Translate } from "../../../../i18n/locale";

type ManagedTelegramOnboardingFlowProps = {
  onBack: () => void;
  onConnected: (detailId: string) => void;
  /** The host has suspended pairing (gateway offline, no permission): the launch
   *  link renders disabled, since a disabled fieldset does not reach anchors. */
  disabled?: boolean;
  dependencies?: ManagedTelegramDependencies;
};

/** Messengers paired through the operator-owned application and a short-lived code. */
export type ManagedMessengerId = "telegram" | "slack" | "discord" | "whatsapp";

type ManagedMessengerOnboardingFlowProps = Omit<ManagedTelegramOnboardingFlowProps, "dependencies"> & {
  adapterId: ManagedMessengerId;
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
  disabled,
  dependencies = defaultDependencies,
}: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return (
    <ManagedMessengerOnboardingFlow
      adapterId="telegram"
      onBack={onBack}
      onConnected={onConnected}
      disabled={disabled}
      dependencies={dependencies}
    />
  );
}

export function ManagedSlackOnboardingFlow({
  onBack,
  onConnected,
  disabled,
  dependencies = defaultDependencies,
}: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return (
    <ManagedMessengerOnboardingFlow
      adapterId="slack"
      onBack={onBack}
      onConnected={onConnected}
      disabled={disabled}
      dependencies={dependencies}
    />
  );
}

export function SharedDiscordOnboardingFlow({ onBack, onConnected, disabled, dependencies = defaultDependencies }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="discord" onBack={onBack} onConnected={onConnected} disabled={disabled} dependencies={dependencies} />;
}

export function ManagedWhatsAppOnboardingFlow({ onBack, onConnected, disabled, dependencies = defaultDependencies }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="whatsapp" onBack={onBack} onConnected={onConnected} disabled={disabled} dependencies={dependencies} />;
}

/** Names the countries the operator's WhatsApp number cannot reach, as the adapter reports them. */
export function whatsAppCountryList(codes: readonly string[], t: Translate): string {
  const sorted = [...codes].sort();
  if (sorted.join(",") === "55,62") return t("settings.pairing.whatsappCountries.both");
  return sorted
    .map((code) => code === "55"
      ? t("settings.pairing.whatsappCountries.brazil")
      : code === "62" ? t("settings.pairing.whatsappCountries.indonesia") : `+${code}`)
    .join(", ");
}

/** The operator's WhatsApp number travels as a wa.me chat link; show it as a number. */
function whatsAppNumberFromChatUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    const digits = url.hostname === "wa.me" ? url.pathname.replace(/^\//, "") : "";
    return /^[1-9][0-9]{4,14}$/.test(digits) ? `+${digits}` : "";
  } catch {
    return "";
  }
}

function ManagedMessengerOnboardingFlow({
  adapterId,
  onBack,
  onConnected,
  disabled = false,
  dependencies,
}: ManagedMessengerOnboardingFlowProps): JSX.Element {
  const t = useT();
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
  const isWhatsApp = adapterId === "whatsapp";
  const installsApp = isSlack || isDiscord;
  const platform = isSlack ? "Slack" : isDiscord ? "Discord" : isWhatsApp ? "WhatsApp" : "Telegram";
  const botUsername = info.data?.botUsername?.replace(/^@/, "") ?? "";
  const chatNumber = isWhatsApp ? whatsAppNumberFromChatUrl(info.data?.installUrl) : "";
  const unreachable = isWhatsApp ? info.data?.unreachableCallingCodes ?? [] : [];
  const launchUrl = installsApp || isWhatsApp
    ? info.data?.installUrl ?? adapterDocUrl(adapterId)
    : botUsername ? `https://t.me/${botUsername}` : "https://telegram.org/";
  const displayIdentity = isWhatsApp
    ? candidate?.actorName
      || candidate?.actorHandle
      || (candidate ? t("settings.pairing.whatsappNumber", { id: candidate.actorId }) : t("settings.pairing.whatsappIdentity"))
    : candidate?.actorHandle
      || candidate?.actorName
      || (candidate ? t("settings.messengers.user", { platform, id: candidate.actorId }) : t("settings.pairing.identity", { platform }));
  const identityDetail = candidate
    ? isWhatsApp
      ? t("settings.pairing.whatsappNumber", { id: candidate.actorHandle ?? candidate.actorId })
      : `${t("settings.pairing.platformId", { platform, id: candidate.actorId })}${isDiscord ? ` · ${candidate.accountId}` : ""}`
    : t("settings.pairing.noIdentity");
  const firstStepText = installsApp
    ? t(isDiscord ? "settings.pairing.installDiscord" : "settings.pairing.installSlack")
    : isWhatsApp
      ? t("settings.pairing.whatsappStart")
      : t("settings.pairing.telegramStart");
  const launchLabel = installsApp
    ? info.data?.installUrl ? t("settings.pairing.installIn", { platform: platform.toUpperCase() }) : t("settings.pairing.viewSetup", { platform: platform.toUpperCase() })
    : isWhatsApp
      ? info.data?.installUrl ? t("settings.pairing.connect") : t("settings.pairing.viewSetup", { platform: "WHATSAPP" })
      : botUsername ? t("settings.pairing.connect") : t("settings.pairing.viewSetup", { platform: "TELEGRAM" });
  // Opening the messenger is the step, so the launch control leads whenever the link is real.
  const launchLeads = installsApp || isWhatsApp ? Boolean(info.data?.installUrl) : Boolean(botUsername);

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

  const detailId = `${adapterId}:${candidate?.accountId ?? info.data?.accountId ?? "managed"}`;

  const flow: ConnectFlowDef = {
    key: `managed-${adapterId}`,
    navLabel: platform.toUpperCase(),
    parentLabel: t("settings.pairing.parent"),
    title: t("settings.pairing.title", { platform }),
    blurb: installsApp
      ? t("settings.pairing.blurbApp", { platform })
      : isWhatsApp
        ? t("settings.pairing.blurbWhatsapp")
        : t("settings.pairing.blurbTelegram"),
    steps: [
      {
        key: "message",
        label: t(installsApp ? "settings.pairing.installLabel" : "settings.pairing.messageLabel"),
        title: t(installsApp ? "settings.pairing.installTitle" : isWhatsApp ? "settings.pairing.messageNumberTitle" : "settings.pairing.messageBotTitle"),
        meta: t("settings.pairing.in", { platform: platform.toUpperCase() }),
        status: t(paired ? "settings.pairing.connected" : "settings.pairing.notConnected"),
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant="attention"
              title={t("settings.pairing.startIn", { platform: platform.toUpperCase() })}
              text={firstStepText}
            />
            {isWhatsApp ? <p class="gsv-cf-note gsv-prose">{chatNumber ? t("settings.pairing.whatsappManual", { number: chatNumber }) : t("settings.pairing.whatsappManualNoNumber")}</p> : null}
            {!installsApp && !isWhatsApp && botUsername ? <p class="gsv-cf-note gsv-prose">{t("settings.pairing.telegramManual", { bot: `@${botUsername}` })}</p> : null}
            {info.isError ? (
              <Alert variant="error" text={info.error?.message ?? t("settings.pairing.loadFailed", { platform })} />
            ) : !info.data?.configured ? (
              <Alert variant="warning" text={t("settings.pairing.notConfigured", { platform })} />
            ) : unreachable.length ? (
              <Alert
                variant="warning"
                text={t("settings.pairing.whatsappUnreachable", { countries: whatsAppCountryList(unreachable, t) })}
              />
            ) : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label={t("settings.pairing.back")} onClick={onBack} />
              <span class="gsv-cf-footer-spacer" />
              {launchLeads
                ? <Button variant="primary" href={launchUrl} label={launchLabel} disabled={disabled} />
                : <Link href={launchUrl}>{launchLabel}</Link>}
              <Button
                variant={launchLeads ? "secondary" : "primary"}
                label={t("settings.pairing.haveCode")}
                disabled={!info.data?.configured}
                onClick={() => setStep(STEP_CODE)}
              />
            </div>
          </>
        ),
      },
      {
        key: "code",
        label: t("settings.pairing.codeLabel"),
        title: t("settings.pairing.codeTitle", { platform }),
        meta: t("settings.pairing.inShip"),
        status: t(paired ? "settings.pairing.connected" : "settings.pairing.pairing"),
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <p class="gsv-cf-desc">{t("settings.pairing.codeHint", { platform })}</p>
            <div style={fieldStyle}>
              <TextInput
                label={t("settings.pairing.codeField")}
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
              <Button variant="secondary" label={t("settings.pairing.back")} onClick={() => setStep(STEP_MESSAGE)} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={t(inspect.isPending ? "settings.pairing.checking" : "settings.pairing.check")}
                disabled={!code.trim() || inspect.isPending}
                onClick={() => void inspectCode()}
              />
            </div>
          </>
        ),
      },
      {
        key: "confirm",
        label: t("settings.pairing.confirmLabel"),
        title: t("settings.pairing.confirmTitle", { platform }),
        meta: t("settings.pairing.inShip"),
        status: t(paired ? "settings.pairing.connected" : "settings.pairing.confirmStatus"),
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <Alert
              variant={candidate?.linked ? "warning" : "attention"}
              title={t(candidate?.linked ? "settings.pairing.replaceTitle" : "settings.pairing.isThisYou")}
              text={candidate?.linked
                ? t("settings.pairing.replaceText", { identity: displayIdentity })
                : t("settings.pairing.confirmText", { platform, identity: displayIdentity })}
            />
            <div class="gsv-cf-framed">
              <ListRow
                label={displayIdentity}
                sub={identityDetail}
                status="none"
              />
            </div>
            {formError ? <Alert variant="error" text={formError} /> : null}
            <div class="gsv-cf-footer">
              <Button variant="secondary" label={t("settings.pairing.back")} onClick={() => setStep(STEP_CODE)} />
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="primary"
                label={t(confirm.isPending ? "settings.pairing.connecting" : "settings.pairing.connectIdentity")}
                disabled={!candidate || confirm.isPending}
                onClick={() => void confirmIdentity()}
              />
            </div>
          </>
        ),
      },
      {
        key: "done",
        label: t("settings.pairing.done"),
        title: t("settings.pairing.doneTitle", { platform }),
        meta: t("settings.pairing.ready"),
        status: t("settings.pairing.connected"),
        tone: "online",
        render: () => (
          <>
            <Alert
              variant="success"
              title={t("settings.pairing.connected")}
              text={t("settings.pairing.doneText", { identity: displayIdentity, platform })}
            />
            <div class="gsv-cf-framed">
              {MESSENGER_CAPABILITIES.map((cap) => (
                <ListRow key={cap.title} label={t(cap.title)} sub={t(cap.detail)} status="none" />
              ))}
            </div>
            <div class="gsv-cf-footer">
              <Button variant="secondary" label={t("settings.pairing.view", { platform: platform.toUpperCase() })} onClick={() => onConnected(detailId)} />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label={t("settings.pairing.done")} onClick={onBack} />
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
