import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useT } from "../../../i18n/locale";
import { Button } from "../../../components/ui/Button";
import "./own-profile.css";

const NOTICE_SEEN = "ui/profile_notice_seen";
/** The notice the owner dismissed; it names Bluesky since "2", so an owner who dismissed an earlier one sees it again once. */
const NOTICE_VERSION = "2";

/**
 * Tells the owner once that their profile is public on the open network, and how to make it
 * private. Their config follows them between the web app and Desktop.
 */
export function ProfileNotice({ ownerUid, published }: { ownerUid: number; published: boolean }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = `users/${ownerUid}/${NOTICE_SEEN}`;
  const queryKey = ["instrument", "profile-notice", ownerUid];
  const seen = useQuery({
    queryKey,
    queryFn: async () => (await client.sys.config.get({ key })).entries.some((entry) => entry.key === key && entry.value === NOTICE_VERSION),
    enabled: connected && published,
  });
  const dismiss = useMutation({
    mutationFn: async () => { await client.sys.config.set({ key, value: NOTICE_VERSION }); },
    onSuccess: () => { cache.setQueryData(queryKey, true); },
  });
  if (!published || seen.data !== false) return null;
  return <aside class="people-profile-notice" aria-labelledby="people-profile-notice-title">
    <h2 id="people-profile-notice-title">{t("people.profile.noticeTitle")}</h2>
    <p>{t("people.profile.noticeBody")}</p>
    <p>{t("people.profile.noticePrivate")}</p>
    {dismiss.isError && <p class="people-error" role="alert">{t("people.profile.noticeFailed")}</p>}
    <div class="people-actions">
      <Button variant="secondary" disabled={!connected || dismiss.isPending} label={t("people.profile.noticeDismiss")} onClick={() => dismiss.mutate()} />
    </div>
  </aside>;
}
