import { useState } from "preact/hooks";
import { Alert } from "../../../../components/ui/Alert";
import { Button } from "../../../../components/ui/Button";
import type { ConsoleIdentityLink } from "../../../../domain/system/consoleModels";
import { useT } from "../../../../i18n/locale";
import {
  useConsoleAdapterPairingInfo,
  useCreateConsoleAdapterPairingLink,
  useDisconnectConsoleAdapterPairing,
} from "../../../../services/system/useConsoleData";
import { useCodeCopy, useCodeCopyOutcome } from "../../shared/codeCopy";
import { messengerLinkName } from "../messengerConnectionsService";
import { LinkQrCode } from "./LinkQrCode";
import { useMessengerLink } from "./useMessengerLink";
import {
  whatsAppNumberFromChatUrl,
  whatsAppReachNotice,
} from "./whatsapp";

export type MessengerChoice = "whatsapp" | "telegram";

type Props = {
  adapter: MessengerChoice;
  name: string;
  /** The person already linked this messenger, so the panel only offers the way back to it. */
  linked: boolean;
  disabled: boolean;
  /** The owner's messenger links, where the connection this card's link makes appears. */
  links?: readonly ConsoleIdentityLink[];
  onRefreshLinks: () => void;
  /** What the second button says once connected: it and opening the messenger both call `onFinish`. */
  doneLabel: string;
  onFinish: () => void;
};

/**
 * The first run's pairing for one messenger, as two numbered steps: open the messenger with the
 * message the card's single-use link fills in and send it, then Ship says hello there. The step to
 * do now holds the filled button. It makes the link with the same calls as Settings › Messengers,
 * names the account that connected so a wrong one can be disconnected, and once linked sends the
 * person back to the messenger.
 */
export function MessengerSteps({ adapter, name, linked, disabled, links, onRefreshLinks, doneLabel, onFinish }: Props) {
  const t = useT();
  const info = useConsoleAdapterPairingInfo(adapter);
  const create = useCreateConsoleAdapterPairingLink();
  const disconnect = useDisconnectConsoleAdapterPairing();
  const pairing = useMessengerLink({
    adapterId: adapter, ready: !linked && !disabled && info.data?.configured === true, links, onRefreshLinks, create, disconnect,
  });
  // Opening the messenger moves the filled button on to what happens next.
  const [launched, setLaunched] = useState(false);

  const isWhatsApp = adapter === "whatsapp";
  const number = isWhatsApp ? whatsAppNumberFromChatUrl(pairing.link?.url ?? info.data?.installUrl) : "";
  const bot = info.data?.botUsername?.replace(/^@/, "") ?? "";
  const chatUrl = isWhatsApp ? number && `https://wa.me/${number.slice(1)}` : bot && `https://t.me/${bot}`;
  const destination = isWhatsApp ? number || t("settings.pairing.shipNumber") : bot ? `@${bot}` : t("settings.pairing.shipBot");
  const unreachable = isWhatsApp ? info.data?.unreachableCallingCodes ?? [] : [];
  const code = pairing.link?.code ?? "";
  const copy = useCodeCopy(() => code, code);
  const copyLabel = useCodeCopyOutcome(copy.state) || t("settings.logs.copy");
  const open = t("settings.pairing.open", { name: name.toUpperCase() });

  // A connection already there needs no link; once the card makes one, only the finished connection it made counts.
  if ((linked && !pairing.started) || pairing.connected) {
    return <div class="messenger-steps">
      <Alert variant="success" title={t("onboarding.surface.connectedTitle")} text={t("onboarding.surface.connectedText", { platform: name })} />
      {/* a link can travel, so the card names who sent it and offers a way out for a wrong account */}
      {pairing.connected && <div class="messenger-who">
        <p class="gsv-cf-note gsv-prose">{t("settings.messengers.connectedTo", { id: messengerLinkName(pairing.connected) })}</p>
        <Button variant="link" label={t(disconnect.isPending ? "settings.pairing.disconnecting" : "onboarding.surface.notYou")}
          disabled={disabled || disconnect.isPending} onClick={() => { setLaunched(false); void pairing.disconnectWrongAccount(); }} />
      </div>}
      {pairing.error && <Alert variant="error" text={pairing.error} />}
      <div class="messenger-actions">
        <Button variant="primary" href={chatUrl} label={open} disabled={disabled || !chatUrl} onClick={onFinish} />
        <Button variant="secondary" label={doneLabel} disabled={disabled} onClick={onFinish} />
      </div>
    </div>;
  }

  // An expired or failed link sends the person back to the first step, where a new one replaces it.
  const retry = !create.isPending && (pairing.expired || pairing.error !== "");
  const second = launched && !retry;

  return <ol class="gsv-cf-rail messenger-steps">
    <li class="gsv-cf-rail-step" aria-current={second ? undefined : "step"}>
      <span class="gsv-cf-rail-mark" aria-hidden="true">
        <span class={`gsv-sp-dot is-${second ? "done" : "cur"}`}>1</span>
        <span class={`gsv-cf-rail-line is-${second ? "done" : "next"}`} />
      </span>
      <div class="gsv-cf-rail-body">
        <p class="messenger-step-title gsv-prose-lead">{t("onboarding.surface.sendStep", { platform: name })}</p>
        <p class="gsv-cf-note gsv-prose">{t(isWhatsApp ? "settings.pairing.linkWhatsappStart" : "settings.pairing.linkTelegramStart")}</p>
        {info.isError && <Alert variant="error" text={info.error?.message ?? t("settings.pairing.loadFailed", { platform: name })} />}
        {info.data && !info.data.configured && <Alert variant="warning" text={t("settings.pairing.notConfigured", { platform: name })} />}
        {pairing.error && <Alert variant="error" text={pairing.error} />}
        {pairing.expired && <p class="gsv-cf-note gsv-prose" role="status">{t("settings.pairing.linkExpired")}</p>}
        {retry
          ? <Button variant="primary" label={t("settings.pairing.newLink")} disabled={disabled} onClick={() => { setLaunched(false); void pairing.mint(); }} />
          : <Button variant={second ? "secondary" : "primary"} href={pairing.waiting ? pairing.link?.url : undefined}
            label={open} disabled={disabled || !pairing.waiting} onClick={() => setLaunched(true)} />}
        {create.isPending && <p class="gsv-cf-note gsv-prose" role="status">{t("settings.pairing.makingLinkStatus")}</p>}
        {/* a phone opens the link itself; a computer shows the code its camera can scan */}
        {pairing.waiting && pairing.link && <div class="gsv-cf-scan">
          <LinkQrCode url={pairing.link.url} label={t("settings.pairing.scanLabel", { platform: name })} />
          <p class="gsv-cf-note gsv-prose gsv-cf-scan-hint">{t("settings.pairing.scan", { platform: name })}</p>
        </div>}
        {whatsAppReachNotice(unreachable, t)}
      </div>
    </li>
    <li class="gsv-cf-rail-step" aria-current={second ? "step" : undefined}>
      <span class="gsv-cf-rail-mark" aria-hidden="true">
        <span class={`gsv-sp-dot is-${second ? "cur" : "next"}`}>2</span>
      </span>
      <div class="gsv-cf-rail-body">
        <p class="messenger-step-title gsv-prose-lead">{t("onboarding.surface.helloStep", { platform: name })}</p>
        {pairing.waiting && <p class="gsv-cf-note gsv-prose" role="status">{t("settings.pairing.waiting")}</p>}
        <details class="gsv-cf-aside gsv-prose messenger-trouble">
          <summary>{t("onboarding.surface.trouble")}</summary>
          {pairing.waiting && pairing.link && <div class="messenger-trouble-line">
            <p>{t("settings.pairing.linkManual", { code: pairing.link.code, destination, platform: name })}</p>
            <Button variant="link" label={copyLabel} onClick={copy.copy} />
          </div>}
          <p>{t("settings.pairing.linkMove", { platform: name })}</p>
        </details>
      </div>
    </li>
  </ol>;
}
