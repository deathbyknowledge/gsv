import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";
import type { ProfilePicture } from "./profilePicture";

export type ProfileEdit = { revision: number; fields: ProfileFields };
/** A picture chosen for the profile, or null to remove the saved one; it stays in the editor until saved. */
export type ProfilePictureEdit = { revision: number; picture: ProfilePicture | null };

/**
 * What the profile editor's main button does. A private profile is published, so the button
 * says publish; a public one is saved in place. `fields` is the draft to commit first, or null
 * when the saved draft is published as it is.
 */
export type ProfileSubmission = { action: "publish" | "save"; ready: boolean; revision: number; fields: ProfileFields | null; picture: ProfilePictureEdit | null };

export function profileSubmission(state: ProfileState, edit: ProfileEdit | null, pictureEdit: ProfilePictureEdit | null = null): ProfileSubmission {
  // The recorded handle names the profile; a stored name that predates it still needs saving, even without other edits.
  const renamePending = !!state.handle && state.draft.displayName !== state.handle;
  const live = !!state.published && state.published.revision === state.revision;
  const stale = (!!edit && edit.revision !== state.revision) || (!!pictureEdit && pictureEdit.revision !== state.revision);
  return {
    action: state.published ? "save" : "publish",
    ready: !stale && (!!edit || !!pictureEdit || !live || renamePending),
    revision: edit?.revision ?? pictureEdit?.revision ?? state.revision,
    fields: edit ? profileNamed(state, edit.fields) : renamePending ? profileNamed(state, state.draft) : null,
    picture: pictureEdit,
  };
}

/** The draft as it is stored: named by the recorded handle, with only the two contact settings the editor offers. */
export function profileNamed(state: ProfileState, shown: ProfileFields): ProfileFields {
  return {
    ...shown,
    ...(state.handle ? { displayName: state.handle } : undefined),
    // The Kernel enforces "closed" exactly like "invitation"; save the option the editor shows.
    ...(shown.contactPolicy === "closed" ? { contactPolicy: "invitation" as const } : undefined),
  };
}

/** Who can reach the owner through the live page now; unpublished changes do not count until published. */
export function profileVisibility(state: ProfileState): "private" | "requests" | "invitation" {
  if (!state.published) return "private";
  return state.published.contactPolicy === "requests" ? "requests" : "invitation";
}
