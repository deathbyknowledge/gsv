import type { ProfileFields, ProfileState } from "@humansandmachines/gsv/protocol";

export type ProfileEdit = { revision: number; fields: ProfileFields };

/**
 * What the profile editor's main button does. A private profile is published, so the button
 * says publish; a public one is saved in place. `fields` is the draft to commit first, or null
 * when the saved draft is published as it is.
 */
export type ProfileSubmission = { action: "publish" | "save"; ready: boolean; revision: number; fields: ProfileFields | null };

export function profileSubmission(state: ProfileState, edit: ProfileEdit | null): ProfileSubmission {
  // The recorded handle names the profile; a stored name that predates it still needs saving, even without other edits.
  const renamePending = !!state.handle && state.draft.displayName !== state.handle;
  const live = !!state.published;
  const stale = !!edit && edit.revision !== state.revision;
  return {
    action: state.published ? "save" : "publish",
    ready: !stale && (!!edit || !live || renamePending),
    revision: edit?.revision ?? state.revision,
    fields: edit ? profileNamed(state, edit.fields) : renamePending ? profileNamed(state, state.draft) : null,
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
