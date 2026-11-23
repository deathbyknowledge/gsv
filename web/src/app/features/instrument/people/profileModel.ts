import {
  BLUESKY_PROFILE_COLLECTION, BLUESKY_PROFILE_RKEY, SHIP_PROFILE_COLLECTION, SHIP_PROFILE_RKEY,
  type ProfileFields, type ProfileState, type PublicTakedown,
} from "@humansandmachines/gsv/protocol";
import type { ProfilePicture } from "./profilePicture";

export type ProfileEdit = { revision: number; fields: ProfileFields };
/** A picture chosen for the profile, or null to remove the saved one; it stays in the editor until saved. */
export type ProfilePictureEdit = { revision: number; picture: ProfilePicture | null };

/**
 * What saving the profile editor publishes: the chosen picture first, then `fields`, or null when
 * only the picture changed. Every save publishes, so the editor shows what people see.
 */
export type ProfileSubmission = { ready: boolean; revision: number; fields: ProfileFields | null; picture: ProfilePictureEdit | null };

export function profileSubmission(state: ProfileState, edit: ProfileEdit | null, pictureEdit: ProfilePictureEdit | null = null): ProfileSubmission {
  // The recorded handle names the profile; a stored name that predates it still needs saving, even without other edits.
  const renamePending = !!state.handle && state.fields.displayName !== state.handle;
  const stale = (!!edit && edit.revision !== state.revision) || (!!pictureEdit && pictureEdit.revision !== state.revision);
  return {
    ready: !stale && (!!edit || !!pictureEdit || renamePending),
    revision: edit?.revision ?? pictureEdit?.revision ?? state.revision,
    fields: edit ? profileNamed(state, edit.fields) : renamePending ? profileNamed(state, state.fields) : null,
    picture: pictureEdit,
  };
}

/** The fields as they are published: named by the recorded handle. */
export function profileNamed(state: ProfileState, shown: ProfileFields): ProfileFields {
  return { ...shown, ...(state.handle ? { displayName: state.handle } : undefined) };
}

/** What a takedown covers, as the person knows it. */
export type TakedownSubject = { kind: "account" | "profile" | "bluesky" | "picture" | "file" } | { kind: "record"; uri: string };

/** Names a takedown as the person knows it: their whole Ship, their profile or its picture, or something else their Ship published. */
export function takedownSubject({ subject }: PublicTakedown, avatarCid?: string): TakedownSubject {
  switch (subject.$type) {
    case "com.atproto.admin.defs#repoRef": return { kind: "account" };
    case "com.atproto.repo.strongRef":
      if (subject.uri.endsWith(`/${SHIP_PROFILE_COLLECTION}/${SHIP_PROFILE_RKEY}`)) return { kind: "profile" };
      // The copy of the profile Bluesky shows.
      if (subject.uri.endsWith(`/${BLUESKY_PROFILE_COLLECTION}/${BLUESKY_PROFILE_RKEY}`)) return { kind: "bluesky" };
      return { kind: "record", uri: subject.uri };
    case "com.atproto.admin.defs#repoBlobRef": return { kind: subject.cid === avatarCid ? "picture" : "file" };
  }
}

/** Whether the operator took down the person's whole Ship, which then reaches no other Ship. */
export function shipTakenDown(takedowns: readonly PublicTakedown[]): boolean {
  return takedowns.some((takedown) => takedownSubject(takedown).kind === "account");
}

/** Whether no one can see the person's profile because their operator took down their whole Ship or the profile itself. */
export function profileTakenDown(takedowns: readonly PublicTakedown[]): boolean {
  return takedowns.some((takedown) => ["account", "profile"].includes(takedownSubject(takedown).kind));
}
