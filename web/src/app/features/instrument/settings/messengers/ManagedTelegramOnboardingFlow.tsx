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
import type { ConsoleIdentityLink } from "../../../../domain/system/consoleModels";
import type { ConsoleAdapterPairingCandidate } from "../../../../services/system/consoleService";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useCreateConsoleAdapterPairingLink,
  useDisconnectConsoleAdapterPairing,
  useInspectConsoleAdapterPairing,
} from "../../../../services/system/useConsoleData";
import { MESSENGER_CAPABILITIES, adapterDocUrl } from "./messengerDocs";
import { MessengerLinkFlow } from "./MessengerLinkFlow";
import { useT } from "../../../../i18n/locale";

type ManagedTelegramOnboardingFlowProps = {
  onBack: () => void;
  onConnected: (detailId: string) => void;
  /** The host has suspended pairing (gateway offline, no permission): the launch
   *  link renders disabled, since a disabled fieldset does not reach anchors. */
  disabled?: boolean;
  dependencies?: ManagedTelegramDependencies;
  /** The owner's messenger links, which a link-connected messenger watches for its new connection. */
  links?: readonly ConsoleIdentityLink[];
  onRefreshLinks?: () => void;
};

/** Messengers paired through the operator-owned application. */
export type ManagedMessengerId = "telegram" | "slack" | "discord" | "whatsapp";

type ManagedMessengerOnboardingFlowProps = Omit<ManagedTelegramOnboardingFlowProps, "dependencies"> & {
  adapterId: ManagedMessengerId;
  dependencies: ManagedTelegramDependencies;
};

export type ManagedTelegramDependencies = {
  ConnectFlowShell: (props: Parameters<typeof ConnectFlowShell>[0]) => ComponentChildren;
  useUnsavedGuard: typeof useUnsavedGuard;
  useConsoleAdapterPairingInfo: (adapter: string) => Pick<ReturnType<typeof useConsoleAdapterPairingInfo>, "data" | "isError" | "error">;
  useCreateConsoleAdapterPairingLink: () => Pick<ReturnType<typeof useCreateConsoleAdapterPairingLink>, "isPending" | "mutateAsync">;
  useDisconnectConsoleAdapterPairing: () => Pick<ReturnType<typeof useDisconnectConsoleAdapterPairing>, "isPending" | "mutateAsync">;
  useInspectConsoleAdapterPairing: () => Pick<ReturnType<typeof useInspectConsoleAdapterPairing>, "isPending" | "mutateAsync">;
  useConfirmConsoleAdapterPairing: () => Pick<ReturnType<typeof useConfirmConsoleAdapterPairing>, "isPending" | "mutateAsync">;
};

const defaultDependencies: ManagedTelegramDependencies = {
  ConnectFlowShell: (props) => <ConnectFlowShell {...props} />,
  useUnsavedGuard: (...args) => useUnsavedGuard(...args),
  useConsoleAdapterPairingInfo: (...args) => useConsoleAdapterPairingInfo(...args),
  useCreateConsoleAdapterPairingLink: () => useCreateConsoleAdapterPairingLink(),
  useDisconnectConsoleAdapterPairing: () => useDisconnectConsoleAdapterPairing(),
  useInspectConsoleAdapterPairing: () => useInspectConsoleAdapterPairing(),
  useConfirmConsoleAdapterPairing: () => useConfirmConsoleAdapterPairing(),
};

const PLATFORM_NAMES = { telegram: "Telegram", slack: "Slack", discord: "Discord", whatsapp: "WhatsApp" } satisfies Record<ManagedMessengerId, string>;

const STEP_CONNECT = 0;
const STEP_CONFIRM = 1;
const STEP_DONE = 2;

export function ManagedTelegramOnboardingFlow({ dependencies = defaultDependencies, ...props }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="telegram" dependencies={dependencies} {...props} />;
}

export function ManagedSlackOnboardingFlow({ dependencies = defaultDependencies, ...props }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="slack" dependencies={dependencies} {...props} />;
}

export function SharedDiscordOnboardingFlow({ dependencies = defaultDependencies, ...props }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="discord" dependencies={dependencies} {...props} />;
}

export function ManagedWhatsAppOnboardingFlow({ dependencies = defaultDependencies, ...props }: ManagedTelegramOnboardingFlowProps): JSX.Element {
  return <ManagedMessengerOnboardingFlow adapterId="whatsapp" dependencies={dependencies} {...props} />;
}

/**
 * A messenger connects the way its adapter says: from a link Ship makes (WhatsApp, Telegram), or by
 * installing the Ship app and pasting the code it sends. Until the adapter answers, the messengers
 * that connect from links show that flow, so it does not flash the other.
 */
function ManagedMessengerOnboardingFlow({ adapterId, disabled = false, ...props }: ManagedMessengerOnboardingFlowProps): JSX.Element {
  const info = props.dependencies.useConsoleAdapterPairingInfo(adapterId);
  const fromLinks = info.data ? info.data.pairingLinks === true : adapterId === "whatsapp" || adapterId === "telegram";
  return fromLinks
    ? <MessengerLinkFlow adapterId={adapterId} platform={PLATFORM_NAMES[adapterId]} info={info} disabled={disabled} {...props} />
    : <MessengerCodeFlow adapterId={adapterId} info={info} disabled={disabled} {...props} />;
}

/** Install the operator's app, mention it, paste the code it sends by DM, and confirm the account it names. */
function MessengerCodeFlow({
  adapterId,
  info,
  onBack,
  onConnected,
  disabled,
  dependencies,
}: ManagedMessengerOnboardingFlowProps & {
  info: ReturnType<ManagedTelegramDependencies["useConsoleAdapterPairingInfo"]>;
  disabled: boolean;
}): JSX.Element {
  const t = useT();
  const inspect = dependencies.useInspectConsoleAdapterPairing();
  const confirm = dependencies.useConfirmConsoleAdapterPairing();
  const [step, setStep] = useState(STEP_CONNECT);
  const [code, setCode] = useState("");
  // Step 2 lights up once the app is opened or a code is typed; both steps stay on screen.
  const [launched, setLaunched] = useState(false);
  const [candidate, setCandidate] = useState<ConsoleAdapterPairingCandidate | null>(null);
  const [formError, setFormError] = useState("");
  const paired = step === STEP_DONE;
  dependencies.useUnsavedGuard(() => !paired && (step > STEP_CONNECT || code.trim().length > 0));

  const isDiscord = adapterId === "discord";
  const platform = PLATFORM_NAMES[adapterId];
  const launchUrl = info.data?.installUrl ?? adapterDocUrl(adapterId);
  const displayIdentity = candidate?.actorHandle
    || candidate?.actorName
    || (candidate ? t("settings.messengers.user", { platform, id: candidate.actorId }) : t("settings.pairing.identity", { platform }));
  const identityDetail = candidate
    ? `${t("settings.pairing.platformId", { platform, id: candidate.actorId })}${isDiscord ? ` · ${candidate.accountId}` : ""}`
    : t("settings.pairing.noIdentity");
  const launchLabel = info.data?.installUrl
    ? t("settings.pairing.installIn", { platform: platform.toUpperCase() })
    : t("settings.pairing.viewSetup", { platform: platform.toUpperCase() });

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
    blurb: t("settings.pairing.blurbApp", { platform }),
    steps: [
      {
        key: "message",
        label: t("settings.pairing.installLabel"),
        title: t("settings.pairing.installTitle"),
        meta: t("settings.pairing.in", { platform: platform.toUpperCase() }),
        status: t(paired ? "settings.pairing.connected" : "settings.pairing.notConnected"),
        tone: paired ? "online" : "idle",
        render: () => (
          <>
            <ol class="gsv-cf-rail" aria-label={t("ui.stepper.label")}>
              <li class="gsv-cf-rail-step is-alert" aria-current={launched ? undefined : "step"}>
                <span class="gsv-cf-rail-mark" aria-hidden="true">
                  <span class={`gsv-sp-dot is-${launched ? "done" : "cur"}`}>1</span>
                  <span class={`gsv-cf-rail-line is-${launched ? "done" : "next"}`} />
                </span>
                <div class="gsv-cf-rail-body">
                  <Alert
                    variant="attention"
                    title={t("settings.pairing.startIn", { platform: platform.toUpperCase() })}
                    text={t(isDiscord ? "settings.pairing.installDiscord" : "settings.pairing.installSlack")}
                  />
                  <div class="gsv-cf-launch">
                    <span class="gsv-cf-footer-spacer" />
                    {/* Installing the app is the step, so the launch control leads whenever the link is real. */}
                    {info.data?.installUrl
                      ? <Button variant="secondary" href={launchUrl} label={launchLabel} disabled={disabled} onClick={() => setLaunched(true)} />
                      : <Link href={launchUrl}>{launchLabel}</Link>}
                  </div>
                  {info.isError ? (
                    <Alert variant="error" text={info.error?.message ?? t("settings.pairing.loadFailed", { platform })} />
                  ) : !info.data?.configured ? (
                    <Alert variant="warning" text={t("settings.pairing.notConfigured", { platform })} />
                  ) : null}
                </div>
              </li>
              {/* the field stays beside the launch step, so a code that already arrived goes straight in */}
              <li class="gsv-cf-rail-step is-field" aria-current={launched ? "step" : undefined}>
                <span class="gsv-cf-rail-mark" aria-hidden="true">
                  <span class={`gsv-sp-dot is-${launched ? "cur" : "next"}`}>2</span>
                </span>
                <div class="gsv-cf-rail-body">
                  <div class="gsv-cf-code">
                    <TextInput
                      label={t("settings.pairing.codeField", { platform: platform.toUpperCase() })}
                      value={code}
                      placeholder="ABCD-EFGH-JKLM"
                      clearable
                      disabled={!info.data?.configured}
                      status={formError ? "error" : "none"}
                      message={formError}
                      onChange={(value) => {
                        setCode(value.toUpperCase());
                        if (value.trim()) setLaunched(true);
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
                    <Button
                      variant="primary"
                      label={t(inspect.isPending ? "settings.pairing.connecting" : "settings.pairing.connect")}
                      disabled={!info.data?.configured || !code.trim() || inspect.isPending}
                      onClick={() => void inspectCode()}
                    />
                  </div>
                </div>
              </li>
            </ol>
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
              <Button variant="secondary" label={t("settings.pairing.back")} onClick={() => setStep(STEP_CONNECT)} />
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
