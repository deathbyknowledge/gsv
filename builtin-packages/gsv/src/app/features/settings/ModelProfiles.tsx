import { useMemo, useState } from "preact/hooks";
import { ActionButton } from "../../components/ui/ActionButton";
import { formatDate } from "./settings-domain";
import {
  buildApplyModelProfileEntries,
  createModelProfile,
  modelProfileMatches,
  modelProfilesConfigKey,
  modelProfileSummary,
  profileValuesFromDrafts,
  readModelProfiles,
  removeModelProfile,
  serializeModelProfiles,
  updateModelProfile,
} from "./model-profiles-domain";
import type {
  AdministrationViewer,
  ModelProfile,
  SaveConfigEntry,
} from "./types";

export function ModelProfiles({
  viewer,
  values,
  draftValues,
  activeValues,
  overrideAiForUser,
  pendingAction,
  onSave,
  onClientError,
}: {
  viewer: AdministrationViewer;
  values: Record<string, string>;
  draftValues: Record<string, string>;
  activeValues: Record<string, string>;
  overrideAiForUser: boolean;
  pendingAction: string | null;
  onSave: (actionId: string, entries: SaveConfigEntry[]) => Promise<void>;
  onClientError: (message: string | null) => void;
}) {
  const [name, setName] = useState("");
  const profiles = useMemo(() => readModelProfiles(values, viewer.uid), [values, viewer.uid]);
  const profileValues = useMemo(() => profileValuesFromDrafts(draftValues), [draftValues]);
  const activeProfileValues = useMemo(() => profileValuesFromDrafts(activeValues), [activeValues]);
  const configKey = modelProfilesConfigKey(viewer.uid);
  const busy = pendingAction?.startsWith("profile:") ?? false;

  async function saveProfiles(actionId: string, nextProfiles: ModelProfile[]): Promise<void> {
    onClientError(null);
    await onSave(actionId, [{ key: configKey, value: serializeModelProfiles(nextProfiles) }]);
  }

  async function saveCurrentProfile(): Promise<void> {
    try {
      const nextProfiles = createModelProfile(profiles, name, profileValues);
      setName("");
      await saveProfiles("profile:save", nextProfiles);
    } catch (error) {
      onClientError(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateProfile(profile: ModelProfile): Promise<void> {
    await saveProfiles(`profile:update:${profile.id}`, updateModelProfile(profiles, profile.id, profileValues));
  }

  async function deleteProfile(profile: ModelProfile): Promise<void> {
    await saveProfiles(`profile:delete:${profile.id}`, removeModelProfile(profiles, profile.id));
  }

  async function applyProfile(profile: ModelProfile): Promise<void> {
    onClientError(null);
    await onSave(
      `profile:apply:${profile.id}`,
      buildApplyModelProfileEntries(profile, viewer, overrideAiForUser),
    );
  }

  return (
    <section class="gsv-admin-model-profiles" aria-label="AI stack profiles">
      <header class="gsv-admin-subhead">
        <div>
          <h5>AI stack profiles</h5>
          <p>{overrideAiForUser ? "Saved personal model stacks for this account." : "Saved root model stacks that apply to system AI defaults."}</p>
        </div>
      </header>

      <div class="gsv-admin-profile-create">
        <input
          type="text"
          value={name}
          maxLength={80}
          placeholder="Stack name"
          disabled={busy}
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <ActionButton
          icon="key"
          label="Save stack"
          busyLabel="Saving"
          busy={pendingAction === "profile:save"}
          disabled={busy || name.trim().length === 0}
          onClick={() => void saveCurrentProfile()}
        />
      </div>

      {profiles.length === 0 ? (
        <p class="gsv-admin-note">No saved AI stack profiles.</p>
      ) : (
        <div class="gsv-admin-profile-list">
          {profiles.map((profile) => {
            const active = modelProfileMatches(profile, activeProfileValues);
            return (
              <article key={profile.id} class={`gsv-admin-profile${active ? " is-active" : ""}`}>
                <div>
                  <strong>{profile.name}</strong>
                  {active ? <span class="gsv-admin-pill">Active</span> : null}
                </div>
                <span>{modelProfileSummary(profile)}</span>
                <span>Updated {formatDate(profile.updatedAt)}</span>
                <div class="gsv-admin-profile-actions">
                  <ActionButton
                    icon="check"
                    label="Apply"
                    busyLabel="Applying"
                    busy={pendingAction === `profile:apply:${profile.id}`}
                    disabled={active || busy}
                    onClick={() => void applyProfile(profile)}
                  />
                  <ActionButton
                    icon="refresh"
                    label="Update"
                    busyLabel="Updating"
                    busy={pendingAction === `profile:update:${profile.id}`}
                    disabled={busy}
                    onClick={() => void updateProfile(profile)}
                  />
                  <ActionButton
                    icon="trash"
                    label="Delete"
                    busyLabel="Deleting"
                    busy={pendingAction === `profile:delete:${profile.id}`}
                    disabled={busy}
                    onClick={() => void deleteProfile(profile)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
