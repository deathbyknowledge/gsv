import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Alert } from "../../../../components/ui/Alert";
import { Button } from "../../../../components/ui/Button";
import { ListRow } from "../../../../components/ui/ListRow";
import type { ConnectFlowDef } from "../../../../components/connect-flow/connectFlowTypes";
import type { ConsoleIdentityLink } from "../../../../domain/system/consoleModels";
import type { ConsoleAdapterPairingLink } from "../../../../services/system/consoleService";
import { useT, type Translate } from "../../../../i18n/locale";
import type { ManagedMessengerId, ManagedTelegramDependencies } from "./ManagedTelegramOnboardingFlow";
import { LinkQrCode } from "./LinkQrCode";
import { MESSENGER_CAPABILITIES } from "./messengerDocs";
import { whatsAppAccountLabel, whatsAppNumberFromChatUrl, whatsAppReachForDevice, whatsAppReachNotice } from "./whatsapp";

/** How often the page looks for the new connection while it waits, in case it misses the live notice. */
const LINK_POLL_MS = 5_000;

type PairingInfo = ReturnType<ManagedTelegramDependencies["useConsoleAdapterPairingInfo"]>;
/** A minted link and when it stops working by this device's clock. */
type HeldLink = ConsoleAdapterPairingLink & { localExpiresAt: number };

export type MessengerLinkFlowProps = {
  adapterId: ManagedMessengerId;
  platform: string;
  info: PairingInfo;
  onBack: () => void;
  onConnected: (detailId: string) => void;
  disabled: boolean;
  dependencies: ManagedTelegramDependencies;
  /** The owner's messenger links, refreshed by the host when the Kernel announces a change. */
  links?: readonly ConsoleIdentityLink[];
  onRefreshLinks?: () => void;
};

/** How Ship names the account a link connected, and the line that identifies it. */
type ConnectedIdentity = { name: string; detail: string };

function connectedIdentity(link: ConsoleIdentityLink, platform: string, isWhatsApp: boolean, t: Translate): ConnectedIdentity {
  if (isWhatsApp) {
    const account = whatsAppAccountLabel(link, t);
    return { name: link.actorName || link.actorHandle || account, detail: account };
  }
  const detail = t("settings.pairing.platformId", { platform, id: link.actorId });
  return {
    name: link.actorName || link.actorHandle || t("settings.messengers.user", { platform, id: link.actorId }),
    detail: link.actorName && link.actorHandle ? `${link.actorHandle} · ${detail}` : detail,
  };
}

/**
 * Connects a messenger from a single-use link: the Kernel mints the code, the messenger carries it
 * in the message the person sends, and the connection appears here once the Kernel makes it. The
 * person never copies a code, and the page names the account so a wrong one can be disconnected.
 */
export function MessengerLinkFlow({
  adapterId,
  platform,
  info,
  onBack,
  onConnected,
  disabled,
  dependencies,
  links,
  onRefreshLinks,
}: MessengerLinkFlowProps): JSX.Element {
  const t = useT();
  const create = dependencies.useCreateConsoleAdapterPairingLink();
  const disconnect = dependencies.useDisconnectConsoleAdapterPairing();
  const [link, setLink] = useState<HeldLink | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [formError, setFormError] = useState("");
  const isWhatsApp = adapterId === "whatsapp";
  const loud = platform.toUpperCase();
  const configured = info.data?.configured === true;
  const expired = link !== null && now >= link.localExpiresAt;
  const connected = link
    ? links?.find((entry) => entry.adapter === adapterId && entry.linkedAt !== undefined && entry.linkedAt >= link.createdAt) ?? null
    : null;
  const waiting = link !== null && !expired && connected === null;
  const unreachable = isWhatsApp ? whatsAppReachForDevice(info.data?.unreachableCallingCodes ?? [], navigator.languages) : [];

  const mint = async () => {
    if (create.isPending) return;
    setFormError("");
    try {
      const next = await create.mutateAsync(adapterId);
      const received = Date.now();
      setNow(received);
      setLink({ ...next, localExpiresAt: received + (next.expiresAt - next.createdAt) });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  // Opening the flow is the choice to connect, so the link is ready before the person reaches for it.
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || disabled || !configured) return;
    requested.current = true;
    void mint();
  }, [disabled, configured]);

  useEffect(() => {
    if (!waiting || !link) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, link.localExpiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [waiting, link]);

  const refresh = useRef(onRefreshLinks);
  refresh.current = onRefreshLinks;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      // A hidden tab hears the live notice when it returns, so it does not need to ask.
      if (document.visibilityState !== "hidden") refresh.current?.();
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  const disconnectWrongAccount = async () => {
    if (!connected || disconnect.isPending) return;
    setFormError("");
    try {
      await disconnect.mutateAsync({ adapter: connected.adapter, accountId: connected.accountId, actorId: connected.actorId });
      setLink(null);
      refresh.current?.();
      await mint();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const destination = isWhatsApp
    ? whatsAppNumberFromChatUrl(link?.url ?? info.data?.installUrl) || t("settings.pairing.shipNumber")
    : info.data?.botUsername ? `@${info.data.botUsername.replace(/^@/, "")}` : t("settings.pairing.shipBot");
  const status = create.isPending
    ? t("settings.pairing.makingLinkStatus")
    : waiting ? t("settings.pairing.waiting") : expired ? t("settings.pairing.linkExpired") : "";
  const identity = connected ? connectedIdentity(connected, platform, isWhatsApp, t) : null;
  const open = t("settings.pairing.open", { name: loud });

  // Opening the messenger leads; once a link expires or fails to arrive, making another takes its place.
  let launch: ComponentChildren;
  if (waiting && link) {
    launch = <Button variant="primary" href={link.url} label={open} disabled={disabled} />;
  } else if (configured && (expired || formError)) {
    launch = <Button variant="secondary" label={t("settings.pairing.newLink")} disabled={disabled || create.isPending} onClick={() => void mint()} />;
  } else {
    launch = <Button variant="primary" label={open} disabled />;
  }

  const flow: ConnectFlowDef = {
    key: `managed-${adapterId}-link`,
    navLabel: loud,
    parentLabel: t("settings.pairing.parent"),
    title: t("settings.pairing.title", { platform }),
    blurb: t("settings.pairing.blurbLink", { platform }),
    steps: [
      {
        key: "message",
        label: t("settings.pairing.messageLabel"),
        title: t(isWhatsApp ? "settings.pairing.messageNumberTitle" : "settings.pairing.messageBotTitle"),
        meta: t("settings.pairing.in", { platform: loud }),
        status: t("settings.pairing.notConnected"),
        tone: "idle",
        render: () => (
          <>
            <Alert
              variant="attention"
              title={t("settings.pairing.startIn", { platform: loud })}
              text={t(isWhatsApp ? "settings.pairing.linkWhatsappStart" : "settings.pairing.linkTelegramStart")}
            />
            <div class="gsv-cf-launch">
              <p class="gsv-cf-note gsv-prose" role="status">{status}</p>
              <span class="gsv-cf-footer-spacer" />
              {launch}
            </div>
            {waiting && link ? (
              <div class="gsv-cf-scan">
                <LinkQrCode url={link.url} label={t("settings.pairing.scanLabel", { platform })} />
                <p class="gsv-cf-note gsv-prose">
                  <span class="gsv-cf-scan-hint">{t("settings.pairing.scan", { platform })} </span>
                  {t("settings.pairing.linkManual", { code: link.code, destination, platform })}
                </p>
              </div>
            ) : null}
            {formError ? <Alert variant="error" text={formError} /> : null}
            {info.isError ? (
              <Alert variant="error" text={info.error?.message ?? t("settings.pairing.loadFailed", { platform })} />
            ) : info.data && !configured ? (
              <Alert variant="warning" text={t("settings.pairing.notConfigured", { platform })} />
            ) : null}
            {configured ? whatsAppReachNotice(unreachable, t) : null}
            <p class="gsv-cf-note gsv-prose">{t("settings.pairing.linkMove", { platform })}</p>
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
              text={t("settings.pairing.doneText", { identity: identity?.name ?? platform, platform })}
            />
            <div class="gsv-cf-framed">
              <ListRow label={identity?.name ?? platform} sub={identity?.detail} status="none" />
            </div>
            <div class="gsv-cf-launch">
              <p class="gsv-cf-note gsv-prose">{t("settings.pairing.notYou", { platform })}</p>
              <span class="gsv-cf-footer-spacer" />
              <Button
                variant="secondary"
                label={t(disconnect.isPending ? "settings.pairing.disconnecting" : "settings.pairing.disconnect")}
                disabled={disabled || disconnect.isPending}
                onClick={() => void disconnectWrongAccount()}
              />
            </div>
            {formError ? <Alert variant="error" text={formError} /> : null}
            <div class="gsv-cf-framed">
              {MESSENGER_CAPABILITIES.map((cap) => (
                <ListRow key={cap.title} label={t(cap.title)} sub={t(cap.detail)} status="none" />
              ))}
            </div>
            <div class="gsv-cf-footer">
              <Button
                variant="secondary"
                label={t("settings.pairing.view", { platform: loud })}
                onClick={() => onConnected(`${adapterId}:${connected?.accountId ?? info.data?.accountId ?? "managed"}`)}
              />
              <span class="gsv-cf-footer-spacer" />
              <Button variant="primary" label={t("settings.pairing.done")} onClick={onBack} />
            </div>
          </>
        ),
      },
    ],
  };

  const FlowShell = dependencies.ConnectFlowShell;
  // The connection, not the person, moves the flow on: it can only show where it stands.
  return <FlowShell flow={flow} current={connected ? 1 : 0} onStep={() => undefined} />;
}
