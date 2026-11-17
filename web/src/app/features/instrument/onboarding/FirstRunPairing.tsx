import { useEffect, useRef, useState } from "preact/hooks";
import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { TextInput } from "../../../components/ui/TextInput";
import { rich, useT } from "../../../i18n/locale";
import {
  useConfirmConsoleAdapterPairing,
  useConsoleAdapterPairingInfo,
  useInspectConsoleAdapterPairing,
} from "../../../services/system/useConsoleData";
import { useCodeCopy, useCodeCopyOutcome } from "../shared/codeCopy";
import {
  whatsAppCountryList,
  whatsAppNumberFromChatUrl,
  whatsAppReachForDevice,
  whatsAppReachSummary,
} from "../settings/messengers/ManagedTelegramOnboardingFlow";

export type MessengerChoice = "whatsapp" | "telegram";

type Props = {
  adapter: MessengerChoice;
  name: string;
  /** The person already linked this messenger, so the panel only offers the way back to it. */
  linked: boolean;
  disabled: boolean;
  onPaired: () => void;
  onFinish: () => void;
};

/**
 * The first run's pairing for one messenger: send Ship a message, then paste the code it replies with, as two
 * numbered steps; the step to do now holds the filled button. It uses the same pairing calls as Settings ›
 * Messengers, including the "is this you?" confirmation, and once linked sends the person back to the messenger.
 */
export function FirstRunPairing({ adapter, name, linked, disabled, onPaired, onFinish }: Props) {
  const t = useT();
  const info = useConsoleAdapterPairingInfo(adapter);
  const inspect = useInspectConsoleAdapterPairing();
  const confirm = useConfirmConsoleAdapterPairing();
  const [code, setCode] = useState("");
  // Opening the messenger, or typing a code that already arrived, moves the filled button to step 2.
  const [launched, setLaunched] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  const isWhatsApp = adapter === "whatsapp";
  const number = isWhatsApp ? whatsAppNumberFromChatUrl(info.data?.installUrl) : "";
  const bot = info.data?.botUsername?.replace(/^@/, "") ?? "";
  const contact = isWhatsApp ? number : bot && `@${bot}`;
  const chatUrl = isWhatsApp ? number && `https://wa.me/${number.slice(1)}` : bot && `https://t.me/${bot}`;
  // WhatsApp's chat link carries the /link message ready to send.
  const launchUrl = isWhatsApp ? info.data?.installUrl : chatUrl;
  const reach = isWhatsApp ? whatsAppReachForDevice(info.data?.unreachableCallingCodes ?? [], navigator.languages) : [];
  const candidate = inspect.data;
  const identity = candidate ? [candidate.actorName, candidate.actorHandle ?? candidate.actorId].filter(Boolean).join(" · ") : "";
  const copy = useCodeCopy(() => contact, contact);
  const copyLabel = useCodeCopyOutcome(copy.state) || t("settings.logs.copy");

  // Coming back from the messenger, the code it sent goes straight into the field.
  useEffect(() => {
    if (!launched) return undefined;
    const focus = () => { if (document.visibilityState === "visible") codeInput.current?.focus(); };
    document.addEventListener("visibilitychange", focus);
    return () => document.removeEventListener("visibilitychange", focus);
  }, [launched]);

  if (linked || confirm.isSuccess) return <div class="first-run-pairing">
    <Alert variant="success" title={t("onboarding.surface.connectedTitle")} text={t("onboarding.surface.connectedText", { platform: name })} />
    <div class="first-run-actions">
      <Button variant="primary" href={chatUrl} label={t("settings.pairing.open", { name: name.toUpperCase() })} disabled={disabled || !chatUrl} onClick={onFinish} />
      <Button variant="secondary" label={t("onboarding.surface.openChatHere")} disabled={disabled} onClick={onFinish} />
    </div>
  </div>;

  const inspectCode = () => {
    if (code.trim() && !inspect.isPending) inspect.mutate({ adapter, code });
  };
  const back = () => {
    inspect.reset();
    confirm.reset();
  };

  return <ol class="gsv-cf-rail first-run-pairing">
    <li class="gsv-cf-rail-step" aria-current={launched ? undefined : "step"}>
      <span class="gsv-cf-rail-mark" aria-hidden="true">
        <span class={`gsv-sp-dot is-${launched ? "done" : "cur"}`}>1</span>
        <span class={`gsv-cf-rail-line is-${launched ? "done" : "next"}`} />
      </span>
      <div class="gsv-cf-rail-body">
        <p class="first-run-step-title gsv-prose-lead">{t("onboarding.surface.sendStep", { platform: name })}</p>
        {info.isError && <Alert variant="error" text={info.error?.message ?? t("settings.pairing.loadFailed", { platform: name })} />}
        <Button variant={launched ? "secondary" : "primary"} href={launchUrl} label={t("settings.pairing.open", { name: name.toUpperCase() })}
          disabled={disabled || !launchUrl} onClick={() => setLaunched(true)} />
        {reach.length > 0 && <details class="gsv-cf-aside gsv-prose">
          <summary>{whatsAppReachSummary(reach, t)}</summary>
          <p>{t("settings.pairing.whatsappUnreachable", { countries: whatsAppCountryList(reach, t) })}</p>
        </details>}
      </div>
    </li>
    <li class="gsv-cf-rail-step" aria-current={launched ? "step" : undefined}>
      <span class="gsv-cf-rail-mark" aria-hidden="true">
        <span class={`gsv-sp-dot is-${launched ? "cur" : "next"}`}>2</span>
      </span>
      <div class="gsv-cf-rail-body">
        <p class="first-run-step-title gsv-prose-lead">{t("onboarding.surface.codeStep")}</p>
        {candidate ? <>
          {/* the code alone cannot choose the account, so the person confirms who sent it */}
          <Alert variant={candidate.linked ? "warning" : "neutral"}
            title={t(candidate.linked ? "settings.pairing.replaceTitle" : "settings.pairing.isThisYou")}
            text={candidate.linked ? t("settings.pairing.replaceText", { identity }) : t("settings.pairing.confirmText", { platform: name, identity })} />
          {confirm.error && <Alert variant="error" text={confirm.error.message} />}
          <div class="first-run-actions">
            <Button variant="primary" label={t(confirm.isPending ? "settings.pairing.connecting" : "settings.pairing.connectIdentity")}
              disabled={disabled || confirm.isPending} onClick={() => confirm.mutate({ adapter, code }, { onSuccess: onPaired })} />
            <Button variant="secondary" label={t("settings.pairing.back")} disabled={confirm.isPending} onClick={back} />
          </div>
        </> : <>
          <div class="first-run-code">
            <TextInput label="" value={code} placeholder="ABCD-EFGH-JKLM" clearable disabled={disabled}
              status={inspect.error ? "error" : "none"} message={inspect.error?.message}
              onChange={(value) => {
                setCode(value.toUpperCase());
                if (value.trim()) setLaunched(true);
                if (inspect.error) inspect.reset();
              }}
              inputProps={{
                ref: codeInput,
                "aria-label": t("onboarding.surface.codeStep"),
                autoComplete: "one-time-code",
                name: `${adapter}PairingCode`,
                onKeyDown: (event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  inspectCode();
                },
              }} />
            <Button variant={launched ? "primary" : "secondary"} label={t(inspect.isPending ? "settings.pairing.connecting" : "settings.pairing.connect")}
              disabled={disabled || !code.trim() || inspect.isPending} onClick={inspectCode} />
          </div>
          {/* a rejected code opens the way to a new one */}
          <details class="gsv-cf-aside gsv-prose first-run-trouble" open={inspect.isError || undefined}>
            <summary>{t("onboarding.surface.trouble")}</summary>
            <div class="first-run-trouble-line">
              <p>{rich(t("onboarding.surface.troubleText", { platform: name }), { contact: <span class="first-run-contact">{contact}</span> })}</p>
              {contact && <Button variant="link" label={copyLabel} onClick={copy.copy} />}
            </div>
            {isWhatsApp && <p>{t("settings.pairing.whatsappRelink")}</p>}
          </details>
        </>}
      </div>
    </li>
  </ol>;
}
