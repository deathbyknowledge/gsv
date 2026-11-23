import { useEffect, useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { contactInviteUrl, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { publicDeployment } from "../../../services/deployment";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { profileNamed } from "./profileModel";
import { useT, type TextKey } from "../../../i18n/locale";

/**
 * The owner's invitation link. It never expires and anyone may use it: whoever opens it creates a
 * Ship, or opens theirs, and sends the owner a message request. That works only while the published
 * profile takes requests, so the link shows once it does.
 */
export function InviteContact({ account, profile, onBusy, onFind }: {
  account: ConsoleAccount | undefined;
  profile: ProfileState | undefined;
  onBusy: (busy: boolean) => void;
  /** Look for someone by handle instead. */
  onFind: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<TextKey | null>(null);
  const published = !!profile?.cid;
  const open = published && profile?.fields.contactPolicy === "requests";
  // Turning requests on publishes the profile with them on.
  const turnOn = useMutation({
    mutationFn: async (state: ProfileState) =>
      (await client.profile.update({ expectedRevision: state.revision, fields: profileNamed(state, { ...state.fields, contactPolicy: "requests" }) })).profile,
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_PROFILE_KEY }),
  });
  useEffect(() => { onBusy(turnOn.isPending); return () => onBusy(false); }, [turnOn.isPending, onBusy]);
  const link = open && profile ? contactInviteUrl(new URL(profile.url).origin, publicDeployment()) : null;

  return <section class="people-invite">
    <h2>{t("people.invite.title")}</h2>
    <p class="people-note">{t("people.invite.intro")}</p>
    {link ? <div class="people-invite-link">
      <label>{t("people.invite.link")}<input aria-label={t("people.invite.link")} value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
      <div class="people-actions"><button class="ibtn is-primary" onClick={async () => {
        try { await navigator.clipboard.writeText(link); setCopyStatus("people.invite.copied"); }
        catch { setCopyStatus("people.invite.selectToCopy"); }
      }}>{t("people.invite.copy")}</button><span class="people-note" role="status">{t(copyStatus ?? "people.invite.ready")}</span></div>
      <p class="people-note">{t("people.invite.reusable")}</p>
    </div> : profile && <div class="people-invite-link">
      {/* The Ship publishes the starting profile as its owner signs in, so this is brief unless the host is down. */}
      <p class="people-note">{t(published ? "people.invite.requestsOff" : "people.invite.publishing")}</p>
      {published && <div class="people-actions">
        <button class="ibtn is-primary" disabled={turnOn.isPending || !connected || !account || !canConfigure(account, "profile.update")} onClick={() => turnOn.mutate(profile)}>
          {t(turnOn.isPending ? "common.saving" : "people.invite.turnOn")}</button>
      </div>}
    </div>}
    <div class="people-compose-footer"><button class="people-action" disabled={turnOn.isPending} onClick={onFind}>{t("people.invite.useProfile")}</button></div>
    {turnOn.error && <p class="people-error" role="alert">{turnOn.error.message}</p>}
    {!connected && <p class="people-note" role="status">{t("people.composer.reconnecting")}</p>}
  </section>;
}
