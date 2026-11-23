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

export type ProfileIntroState = {
  shown: boolean;
  /** Something chosen or written here that isn't published yet, or a save still running. */
  dirty: boolean;
  about: string;
  picture: ProfilePicture | null;
  changed: boolean;
  setAbout: (about: string) => void;
  setPicture: (picture: ProfilePicture | null) => void;
  saving: boolean;
  saved: boolean;
  saveError: Error | null;
  save: (profile: ProfileState) => void;
  finishing: boolean;
  finishError: boolean;
  finish: () => Promise<void>;
};

/**
 * People's introduction to the owner's public profile: once, while it is still the one their Ship started
 * with. It stays open until the owner saves or skips it, through a save that changes the profile beneath it
 * and while they look elsewhere in People with something unsaved. The draft lives here rather than in the
 * step, as contact drafts do, so it survives opening a conversation. Whether it was seen is the owner's
 * config, which follows them between the web app and Desktop.
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
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState<ProfilePicture | null>(null);
  // What this step last published, so a retry publishes only what's left and nothing set elsewhere is overwritten.
  const [published, setPublished] = useState<{ about: string; picture: ProfilePicture | null }>({ about: "", picture: null });
  const finish = useMutation({
    mutationFn: async () => { await client.sys.config.set({ key, value: "1" }); },
    onSuccess: () => { cache.setQueryData(queryKey, true); },
  });
  const finishIntro = async () => { await finish.mutateAsync().catch(() => {}); };
  // Each step publishes: the picture first, then the words at the revision it leaves.
  const save = useMutation({
    mutationFn: async (start: ProfileState) => {
      let state = start;
      if (picture !== published.picture) {
        state = await saveProfilePicture(client, state.revision, picture);
        setPublished((was) => ({ ...was, picture }));
        cache.setQueryData([...INSTRUMENT_PROFILE_KEY, ownerUid], state);
      }
      const words = about.trim();
      if (words !== published.about) {
        state = (await client.profile.update({ expectedRevision: state.revision, fields: profileNamed(state, { ...state.fields, about: words }) })).profile;
        setPublished((was) => ({ ...was, about: words }));
        cache.setQueryData([...INSTRUMENT_PROFILE_KEY, ownerUid], state);
      }
    },
    onSuccess: finishIntro,
  });
  const changed = picture !== published.picture || about.trim() !== published.about;
  const pending = save.isPending || finish.isPending;
  const [held, setHeld] = useState(false);
  useEffect(() => { setHeld((was) => (landing || changed || pending) && (was || starting)); }, [landing, changed, pending, starting]);
  const open = seen.data === false && (starting || held);
  return {
    shown: open && landing,
    dirty: open && (changed || pending),
    about, picture, changed, setAbout, setPicture,
    saving: save.isPending, saved: save.isSuccess, saveError: save.error, save: save.mutate,
    finishing: finish.isPending, finishError: finish.isError, finish: finishIntro,
  };
}

/** A picture and a few words for the profile every Ship publishes. Saving publishes them; skipping leaves the profile the Ship started with. */
export function ProfileIntro({ profile, intro }: { profile: ProfileState; intro: ProfileIntroState }) {
  const t = useT();
  const { connected } = useGateway();
  const chosen = useMemo(() => intro.picture ? new Blob([intro.picture.bytes.slice()], { type: intro.picture.mimeType }) : null, [intro.picture]);
  const pictureUrl = useObjectUrl(chosen);
  const busy = intro.saving || intro.finishing || !connected;

  return <section class="people-welcome people-intro" aria-labelledby="people-intro-title">
    <h2 id="people-intro-title">{t("people.intro.title")}</h2>
    <p class="people-welcome-intro">{t("people.intro.lead", { address: new URL(gatewayHttpOrigin()).host })}</p>
    {intro.finishError && <p class="people-error" role="alert">{t("people.profile.noticeFailed")}</p>}
    {intro.saveError && <p class="people-error" role="alert">{intro.saveError.message}</p>}
    <div class="people-form">
      <ProfilePicturePicker src={pictureUrl} disabled={busy} error={null} onChoose={intro.setPicture} onRemove={() => intro.setPicture(null)} />
      <TextArea label={t("people.profile.about")} value={intro.about} maxLength={2048} rows={4} disabled={busy} placeholder={t("people.profile.emptyBio")} onChange={intro.setAbout} />
      <p class="people-note">{t("people.profile.saveNote")}</p>
    </div>
    <div class="people-welcome-actions">
      <Button variant="primary" label={intro.saving ? t("common.saving") : t("people.intro.save")} disabled={busy || (!intro.changed && !intro.saved)} onClick={() => intro.save(profile)} />
      <Button variant="secondary" label={t("people.intro.skip")} disabled={busy} onClick={() => { void intro.finish(); }} />
    </div>
  </section>;
}
