import type { PublicTakedown } from "@humansandmachines/gsv/protocol";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { useT } from "../../../i18n/locale";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_TAKEDOWNS_KEY } from "../wire/queryKeys";
import { takedownSubject } from "./profileModel";
import "./own-profile.css";

/** Takedowns are rare, and only the operator changes them, so People reads them again after a few minutes. */
const TAKEDOWNS_STALE_MS = 5 * 60_000;

const SUBJECT_TEXT = {
  account: "people.profile.takedownAccount",
  profile: "people.profile.takedownProfile",
  picture: "people.profile.takedownPicture",
  file: "people.profile.takedownFile",
} as const;

/** What the person's operator has taken down of what their Ship publishes on the open network. */
export function useShipTakedowns(account: ConsoleAccount | null | undefined, enabled: boolean): PublicTakedown[] {
  const { client, connected } = useGateway();
  const identity = useQuery({
    queryKey: [...INSTRUMENT_TAKEDOWNS_KEY, account?.uid],
    queryFn: async () => (await client.atproto.identity({})).takedowns,
    enabled: connected && enabled && !!account && canConfigure(account, "atproto.identity"),
    staleTime: TAKEDOWNS_STALE_MS,
  });
  return identity.data ?? [];
}

/** Tells the person what their operator took down, and the reason the operator gave. */
export function ProfileTakedowns({ takedowns, avatarCid }: { takedowns: readonly PublicTakedown[]; avatarCid?: string }) {
  const t = useT();
  if (takedowns.length === 0) return null;
  return <aside class="people-profile-notice is-takedown" aria-labelledby="people-profile-takedown-title">
    <h2 id="people-profile-takedown-title">{t("people.profile.takedownTitle")}</h2>
    <p>{t("people.profile.takedownBody")}</p>
    <ul class="people-profile-takedowns">{takedowns.map((takedown) => {
      const subject = takedownSubject(takedown, avatarCid);
      return <li key={JSON.stringify(takedown.subject)}>
        <strong>{subject.kind === "record" ? t("people.profile.takedownRecord", { uri: subject.uri }) : t(SUBJECT_TEXT[subject.kind])}</strong>
        <p>{takedown.reason ? t("people.profile.takedownReason", { reason: takedown.reason }) : t("people.profile.takedownNoReason")}</p>
        <p class="people-note">{t("people.profile.takedownSince", { date: new Date(takedown.at).toLocaleDateString() })}</p>
      </li>;
    })}</ul>
  </aside>;
}
