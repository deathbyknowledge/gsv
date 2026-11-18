import { useEffect, useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { contactInviteUrl, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { publicDeployment } from "../../../services/deployment";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { profileNamed, profileUnpublished } from "./profileModel";
import { useT, type TextKey } from "../../../i18n/locale";

/**
 * The owner's invitation link. It never expires and anyone may use it: whoever opens it creates a
 * Ship, or opens theirs, and sends the owner a message request. That works only while the live
 * profile takes requests, so the link shows once it does.
 */
export function InviteContact({ account, profile, onBusy, onFind, onEditProfile }: {
  account: ConsoleAccount | undefined;
  profile: ProfileState | undefined;
  onBusy: (busy: boolean) => void;
  /** Look for someone by handle instead. */
  onFind: () => void;
  onEditProfile: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<TextKey | null>(null);
  const allowed = (name: string) => connected && !!account && canConfigure(account, name);
  const open = profile?.published?.contactPolicy === "requests";
  // Turning requests on publishes the profile; changes the owner hasn't published yet are theirs to review first.
  const unpublished = !!profile && profileUnpublished(profile);
  const turnOn = useMutation({
    mutationFn: async (state: ProfileState) => {
      // Only a stored draft publishes; revision 0 is the Kernel's default, which nothing has saved yet.
      const saved = state.revision > 0 && state.draft.contactPolicy === "requests" ? state
        : (await client.profile.update({ expectedRevision: state.revision, draft: profileNamed(state, { ...state.draft, contactPolicy: "requests" }) })).profile;
      return (await client.profile.publish({ expectedRevision: saved.revision })).profile;
    },
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
      <p class="people-note">{t(profile.published ? "people.invite.requestsOff" : "people.invite.private")}</p>
      <div class="people-actions">{unpublished
        ? <button class="ibtn is-primary" disabled={!connected} onClick={onEditProfile}>{t("people.invite.reviewProfile")}</button>
        : <button class="ibtn is-primary" disabled={turnOn.isPending || !allowed("profile.update") || !allowed("profile.publish")} onClick={() => turnOn.mutate(profile)}>
          {t(turnOn.isPending ? "common.saving" : "people.invite.turnOn")}</button>}</div>
      {unpublished && <p class="people-note">{t("people.invite.unpublishedFirst")}</p>}
    </div>}
    <div class="people-compose-footer"><button class="people-action" disabled={turnOn.isPending} onClick={onFind}>{t("people.invite.useProfile")}</button></div>
    {turnOn.error && <p class="people-error" role="alert">{turnOn.error.message}</p>}
    {!connected && <p class="people-note" role="status">{t("people.composer.reconnecting")}</p>}
  </section>;
}
