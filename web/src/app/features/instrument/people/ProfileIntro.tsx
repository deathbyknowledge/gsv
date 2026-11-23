import { useMutation, useQueryClient } from "@tanstack/preact-query";
import type { ProfileState } from "@humansandmachines/gsv/protocol";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { TextArea } from "../../../components/ui/TextArea";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useQuery } from "../../../services/navigation/viewQueries";
import { gatewayHttpOrigin } from "../../../services/platform/gatewayOrigin";
import { useT } from "../../../i18n/locale";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { profileNamed } from "./profileModel";
import { saveProfilePicture, type ProfilePicture } from "./profilePicture";
import { ProfilePicturePicker, useObjectUrl } from "./ProfilePicturePicker";

const INTRO_SEEN = "ui/profile_intro_seen";

/** Whether the owner's published profile is still the one their Ship started with. */
export function startingProfile(profile: ProfileState | undefined): profile is ProfileState {
  return !!profile?.cid && !profile.avatar && !profile.fields.about;
}

export type ProfileIntroState = { shown: boolean; finishing: boolean; finishError: boolean; finish: () => Promise<void> };

/**
 * Whether People's landing introduces the owner's public profile: once, while it is still the one their
 * Ship started with. Once on screen it stays until the owner saves or skips it, though saving changes the
 * profile beneath it. Their config follows them between the web app and Desktop.
 */
export function useProfileIntro(ownerUid: number | undefined, profile: ProfileState | undefined, landing: boolean): ProfileIntroState {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = `users/${ownerUid}/${INTRO_SEEN}`;
  const queryKey = ["instrument", "profile-intro", ownerUid];
  const starting = startingProfile(profile);
  const seen = useQuery({
    queryKey,
    queryFn: async () => (await client.sys.config.get({ key })).entries.some((entry) => entry.key === key && entry.value === "1"),
    enabled: connected && ownerUid !== undefined && starting,
  });
  const [held, setHeld] = useState(false);
  useEffect(() => { setHeld((was) => landing && (was || starting)); }, [landing, starting]);
  const finish = useMutation({
    mutationFn: async () => { await client.sys.config.set({ key, value: "1" }); },
    onSuccess: () => { cache.setQueryData(queryKey, true); },
  });
  return {
    shown: landing && seen.data === false && (starting || held),
    finishing: finish.isPending,
    finishError: finish.isError,
    finish: async () => { await finish.mutateAsync().catch(() => {}); },
  };
}

type Props = {
  ownerUid: number;
  profile: ProfileState;
  finishing: boolean;
  finishError: boolean;
  onFinish: () => Promise<void>;
};

/** A picture and a few words for the profile every Ship publishes. Saving publishes them; skipping leaves the profile the Ship started with. */
export function ProfileIntro({ ownerUid, profile, finishing, finishError, onFinish }: Props) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState<ProfilePicture | null>(null);
  // The picture the profile last published from here, so a retry doesn't publish it again.
  const [publishedPicture, setPublishedPicture] = useState<ProfilePicture | null>(null);
  const chosen = useMemo(() => picture ? new Blob([picture.bytes.slice()], { type: picture.mimeType }) : null, [picture]);
  const pictureUrl = useObjectUrl(chosen);
  // Each step publishes: the picture first, then the words at the revision it leaves.
  const save = useMutation({
    mutationFn: async () => {
      let state = profile;
      if (picture !== publishedPicture) {
        state = await saveProfilePicture(client, state.revision, picture);
        setPublishedPicture(picture);
        cache.setQueryData([...INSTRUMENT_PROFILE_KEY, ownerUid], state);
      }
      if (about.trim() !== state.fields.about) {
        state = (await client.profile.update({ expectedRevision: state.revision, fields: profileNamed(state, { ...state.fields, about: about.trim() }) })).profile;
        cache.setQueryData([...INSTRUMENT_PROFILE_KEY, ownerUid], state);
      }
    },
    onSuccess: () => onFinish(),
  });
  const busy = finishing || save.isPending || !connected;
  const changed = picture !== publishedPicture || about.trim() !== profile.fields.about;

  return <section class="people-welcome people-intro" aria-labelledby="people-intro-title">
    <h2 id="people-intro-title">{t("people.intro.title")}</h2>
    <p class="people-welcome-intro">{t("people.intro.lead", { address: new URL(gatewayHttpOrigin()).host })}</p>
    {finishError && <p class="people-error" role="alert">{t("people.profile.noticeFailed")}</p>}
    {save.error && <p class="people-error" role="alert">{save.error.message}</p>}
    <div class="people-form">
      <ProfilePicturePicker src={pictureUrl} disabled={busy} error={null} onChoose={setPicture} onRemove={() => setPicture(null)} />
      <TextArea label={t("people.profile.about")} value={about} maxLength={2048} rows={4} disabled={busy} placeholder={t("people.profile.emptyBio")} onChange={setAbout} />
      <p class="people-note">{t("people.profile.saveNote")}</p>
    </div>
    <div class="people-welcome-actions">
      <Button variant="primary" label={save.isPending ? t("common.saving") : t("people.intro.save")} disabled={busy || (!changed && !save.isSuccess)} onClick={() => save.mutate()} />
      <Button variant="secondary" label={t("people.intro.skip")} disabled={busy} onClick={() => { void onFinish(); }} />
    </div>
  </section>;
}
